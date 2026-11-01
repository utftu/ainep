import { createHash, timingSafeEqual } from "node:crypto";
import type { Server, TLSOptions } from "bun";
import { createServer, H11, type WsData } from "h11";

import { claudeProvider } from "../providers/claude/claude.ts";
import type { Provider, ProviderRoute } from "../providers/provider.ts";

import { sanitizeBody } from "../privacy/privacy.ts";

export class ProxyConfigurationError extends Error {}

export type ProxyOptions = {
  gatewayToken: string;
  hostname?: string;
  port?: number;
  tls?: TLSOptions;
  upstreamOrigins?: Record<string, string>;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  log?: (event: ProxyEvent) => void;
};

export type ProxyEvent = {
  provider: string;
  route: string;
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

function authenticate(req: Request, expectedHash: Buffer): boolean {
  const token = req.headers.get("x-gateway-token");
  if (token === null) {
    return false;
  }
  const actualHash = createHash("sha256").update(token).digest();
  return timingSafeEqual(actualHash, expectedHash);
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
  provider: Provider;
  route: ProviderRoute;
  requestTimeoutMs: number;
  maxBodyBytes: number;
}): Promise<Response> {
  const incoming = new URL(req.url);
  const invalid = options.provider.validateRequest(req);
  if (invalid !== undefined) {
    return createError(invalid.status, invalid.message);
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
    checkBody: options.route.checkBody,
    encoding: req.headers.get("content-encoding") ?? undefined,
    maxBodyBytes: options.maxBodyBytes,
  });
  if ("status" in sanitized) {
    return createError(sanitized.status, sanitized.message);
  }

  // Only a validated route and the single supported query flag reach a fixed origin.
  const upstream = new URL(options.upstreamOrigin);
  upstream.pathname = options.route.upstreamPath;
  upstream.search = incoming.search;
  const deadline = AbortSignal.timeout(options.requestTimeoutMs);
  const cancellation = new AbortController();
  const signal = AbortSignal.any([req.signal, deadline, cancellation.signal]);
  const response = await fetch(upstream, {
    method: "POST",
    headers: options.provider.buildHeaders(req),
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
    headers: options.provider.buildResponseHeaders(response),
  });
}

export function startProxy(options: ProxyOptions): Server<WsData> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 8443;
  const providers = [claudeProvider];
  const maxBodyBytes = options.maxBodyBytes ?? 16 * 1024 * 1024;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10 * 60 * 1000;

  if (!checkToken(options.gatewayToken)) {
    throw new ProxyConfigurationError("GATEWAY_TOKEN must contain at least 32 printable ASCII characters without spaces");
  }
  if (Bun.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new ProxyConfigurationError("TLS certificate verification must stay enabled");
  }
  if (!checkLoopback(hostname) && (!options.tls?.cert || !options.tls?.key)) {
    throw new ProxyConfigurationError("Non-loopback listeners require a TLS certificate and key");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new ProxyConfigurationError("Invalid port, body limit or request timeout");
  }

  const gatewayHash = createHash("sha256").update(options.gatewayToken).digest();
  const h11 = new H11();
  const routes = new Map<string, { provider: Provider; route: ProviderRoute }>();
  for (const id in options.upstreamOrigins) {
    if (!providers.some((provider) => provider.id === id)) {
      throw new ProxyConfigurationError("Unknown upstream provider override");
    }
  }
  h11.use(({ req }) => {
    if (!authenticate(req, gatewayHash)) {
      return createError(401, "Unauthorized");
    }
    if (req.method !== "POST" || !routes.has(new URL(req.url).pathname)) {
      return createError(404, "Route not supported");
    }
  });
  for (const provider of providers) {
    const upstream = new URL(options.upstreamOrigins?.[provider.id] ?? provider.origin);
    if (upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) {
      throw new ProxyConfigurationError("Upstream must be an origin without credentials, path, query or fragment");
    }
    if (upstream.protocol !== "https:" && !(upstream.protocol === "http:" && checkLoopback(upstream.hostname))) {
      throw new ProxyConfigurationError("Upstream must use HTTPS; HTTP is allowed only for a local test server");
    }
    for (const route of provider.routes) {
      routes.set(route.path, { provider, route });
      h11.post(route.path, ({ req }) => forwardRequest(req, {
        upstreamOrigin: upstream.origin, provider, route, requestTimeoutMs, maxBodyBytes,
      }));
    }
  }
  h11.onNotFound = () => createError(404, "Route not supported");
  h11.onError = () => createError(500, "Request could not be processed");
  h11.ee.on("response", ({ req, res, ms }) => {
    const match = routes.get(new URL(req.url).pathname);
    options.log?.({ provider: match?.provider.id ?? "rejected", route: match?.route.name ?? "rejected", status: res.status, durationMs: Math.round(ms) });
  });

  return Bun.serve({
    hostname, port, tls: options.tls,
    maxRequestBodySize: maxBodyBytes,
    idleTimeout: 60,
    ...createServer({ h11 }),
  });
}
