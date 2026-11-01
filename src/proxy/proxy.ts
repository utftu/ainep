import { createHash, timingSafeEqual } from "node:crypto";
import type { Server, TLSOptions } from "bun";
import { createServer, H11, type WsData } from "h11";

import { sanitizeBody } from "../privacy/privacy.ts";

export type ProxyOptions = {
  gatewayToken: string;
  hostname?: string;
  port?: number;
  tls?: TLSOptions;
  upstreamOrigin?: string;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  log?: (event: ProxyEvent) => void;
};

export type ProxyEvent = {
  route: "messages" | "count_tokens" | "rejected";
  status: number;
  durationMs: number;
};

function checkLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function checkToken(token: string): boolean {
  if (token.length < 32) {
    return false;
  }
  for (const char of token) {
    const code = char.charCodeAt(0);
    if (code <= 32 || code >= 127) {
      return false;
    }
  }
  return true;
}

function createError(status: number, message: string): Response {
  return Response.json({ type: "error", error: { type: "gateway_error", message } }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function getRoute(pathname: string): ProxyEvent["route"] {
  if (pathname === "/v1/messages") {
    return "messages";
  }
  if (pathname === "/v1/messages/count_tokens") {
    return "count_tokens";
  }
  return "rejected";
}

function authenticate(req: Request, expectedHash: Buffer): boolean {
  const token = req.headers.get("x-gateway-token");
  const authorization = req.headers.get("authorization");
  if (token === null || req.headers.has("x-api-key") || !authorization?.startsWith("Bearer ")) {
    return false;
  }
  const accessToken = authorization.slice(7);
  if (!checkToken(accessToken) || accessToken.includes(",") || accessToken === token) {
    return false;
  }
  const actualHash = createHash("sha256").update(token).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function buildHeaders(req: Request): Headers {
  // Forward client OAuth only to the fixed upstream; the separate gateway secret stays here.
  const headers = new Headers({
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    "accept-encoding": "identity",
    "anthropic-version": req.headers.get("anthropic-version") ?? "2023-06-01",
    "authorization": req.headers.get("authorization")!,
  });
  const beta = req.headers.get("anthropic-beta");
  if (beta !== null) {
    headers.set("anthropic-beta", beta);
  }
  return headers;
}

function buildResponseHeaders(response: Response): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of ["content-type", "request-id", "retry-after"]) {
    const value = response.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  // fetch may decode the response, so upstream length/encoding must not be copied.
  for (const [name, value] of response.headers) {
    if (name.startsWith("anthropic-ratelimit-")) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function readBody(req: Request, maxBodyBytes: number): Promise<Buffer<ArrayBuffer> | Response> {
  if (Number(req.headers.get("content-length")) > maxBodyBytes) {
    return createError(413, "Request body is too large");
  }
  if (req.body === null) {
    return createError(400, "Request body is required");
  }
  // Read the original Request: h11's size-limit module currently drops its AbortSignal.
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read().catch(() => undefined);
    if (chunk === undefined) {
      reader.releaseLock();
      return createError(400, "Request body could not be read");
    }
    if (chunk.done) {
      reader.releaseLock();
      return Buffer.concat(chunks, size);
    }
    size += chunk.value.byteLength;
    if (size > maxBodyBytes) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      return createError(413, "Request body is too large");
    }
    chunks.push(chunk.value);
  }
}

function streamResponse(body: ReadableStream<Uint8Array>, cancellation: AbortController): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  // Explicit cancellation is necessary when Bun has already sent response headers.
  return new ReadableStream({
    async pull(controller): Promise<void> {
      const chunk = await reader.read().catch(() => undefined);
      if (chunk === undefined) {
        controller.error(new Error("Upstream stream interrupted"));
        return;
      }
      if (chunk.done) {
        controller.close();
        return;
      }
      controller.enqueue(chunk.value);
    },
    async cancel(): Promise<void> {
      cancellation.abort();
      await reader.cancel().catch(() => undefined);
    },
  });
}

async function forwardRequest(req: Request, options: {
  upstreamOrigin: string;
  requestTimeoutMs: number;
  maxBodyBytes: number;
}): Promise<Response> {
  const incoming = new URL(req.url);
  for (const [name, value] of incoming.searchParams) {
    if (name !== "beta" || value !== "true" || incoming.searchParams.getAll(name).length !== 1) {
      return createError(400, "Unsupported query parameters");
    }
  }
  const version = req.headers.get("anthropic-version");
  if (version !== null && version !== "2023-06-01") {
    return createError(400, "Unsupported API version");
  }
  if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return createError(415, "Expected application/json");
  }

  const body = await readBody(req, options.maxBodyBytes);
  if (body instanceof Response) {
    return body;
  }
  const sanitized = await sanitizeBody({
    body,
    route: incoming.pathname === "/v1/messages/count_tokens" ? "count_tokens" : "messages",
    encoding: req.headers.get("content-encoding") ?? undefined,
    maxBodyBytes: options.maxBodyBytes,
  });
  if ("status" in sanitized) {
    return createError(sanitized.status, sanitized.message);
  }

  // Only a validated route and the single supported query flag reach a fixed origin.
  const upstream = new URL(options.upstreamOrigin);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  const deadline = AbortSignal.timeout(options.requestTimeoutMs);
  const cancellation = new AbortController();
  const signal = AbortSignal.any([req.signal, deadline, cancellation.signal]);
  const response = await fetch(upstream, {
    method: "POST",
    headers: buildHeaders(req),
    body: sanitized.body,
    redirect: "manual",
    signal,
  }).catch(() => undefined);

  if (response === undefined) {
    if (req.signal.aborted) {
      return createError(499, "Client disconnected");
    }
    return createError(deadline.aborted ? 504 : 502, "Upstream request failed");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return createError(502, "Upstream redirects are not allowed");
  }

  return new Response(response.body === null ? null : streamResponse(response.body, cancellation), {
    status: response.status,
    headers: buildResponseHeaders(response),
  });
}

export function startProxy(options: ProxyOptions): Server<WsData> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 8443;
  const upstream = new URL(options.upstreamOrigin ?? "https://api.anthropic.com");
  const maxBodyBytes = options.maxBodyBytes ?? 16 * 1024 * 1024;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10 * 60 * 1000;

  if (!checkToken(options.gatewayToken)) {
    throw new Error("Set a gateway token of at least 32 printable characters");
  }
  if (Bun.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("TLS certificate verification must stay enabled");
  }
  if (!checkLoopback(hostname) && (!options.tls?.cert || !options.tls?.key)) {
    throw new Error("Non-loopback listeners require a TLS certificate and key");
  }
  if (upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) {
    throw new Error("Upstream must be an origin without credentials, path, query or fragment");
  }
  if (upstream.protocol !== "https:" && !(upstream.protocol === "http:" && checkLoopback(upstream.hostname))) {
    throw new Error("Upstream must use HTTPS; HTTP is allowed only for a local test server");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error("Invalid port, body limit or request timeout");
  }

  const gatewayHash = createHash("sha256").update(options.gatewayToken).digest();
  const h11 = new H11();
  h11.use(({ req }) => {
    if (!authenticate(req, gatewayHash)) {
      return createError(401, "Unauthorized");
    }
    if (req.method !== "POST" || getRoute(new URL(req.url).pathname) === "rejected") {
      return createError(404, "Route not supported");
    }
  });
  h11.post("/v1/messages", ({ req }) => forwardRequest(req, {
    upstreamOrigin: upstream.origin, requestTimeoutMs, maxBodyBytes,
  }));
  h11.post("/v1/messages/count_tokens", ({ req }) => forwardRequest(req, {
    upstreamOrigin: upstream.origin, requestTimeoutMs, maxBodyBytes,
  }));
  h11.onNotFound = () => createError(404, "Route not supported");
  h11.onError = () => createError(500, "Request could not be processed");
  h11.ee.on("response", ({ req, res, ms }) => {
    options.log?.({ route: getRoute(new URL(req.url).pathname), status: res.status, durationMs: Math.round(ms) });
  });

  return Bun.serve({
    hostname, port, tls: options.tls,
    maxRequestBodySize: maxBodyBytes,
    idleTimeout: 60,
    ...createServer({ h11 }),
  });
}
