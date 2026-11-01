import type { Provider, ProviderError } from "../provider.ts";

import { checkRequestSchema } from "./schema.ts";

function validateRequest(req: Request): ProviderError | undefined {
  const authorization = req.headers.get("authorization");
  if (req.headers.has("x-api-key") || !authorization?.startsWith("Bearer ")) {
    return { status: 401, message: "Claude OAuth Bearer is required" };
  }
  const token = authorization.slice(7);
  if (token.length < 32 || token.includes(",") || token === req.headers.get("x-gateway-token")) {
    return { status: 401, message: "Invalid Claude OAuth Bearer" };
  }
  for (const char of token) {
    const code = char.charCodeAt(0);
    if (code <= 32 || code >= 127) {
      return { status: 401, message: "Invalid Claude OAuth Bearer" };
    }
  }
  const query = new URL(req.url).searchParams;
  for (const [name, value] of query) {
    if (name !== "beta" || value !== "true" || query.getAll(name).length !== 1) {
      return { status: 400, message: "Unsupported query parameters" };
    }
  }
  const version = req.headers.get("anthropic-version");
  if (version !== null && version !== "2023-06-01") {
    return { status: 400, message: "Unsupported API version" };
  }
  return;
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

export const claudeProvider: Provider = {
  id: "claude",
  origin: "https://api.anthropic.com",
  routes: [
    { name: "messages", path: "/claude/v1/messages", upstreamPath: "/v1/messages", checkBody: (value) => checkRequestSchema(value, "messages") },
    { name: "count_tokens", path: "/claude/v1/messages/count_tokens", upstreamPath: "/v1/messages/count_tokens", checkBody: (value) => checkRequestSchema(value, "count_tokens") },
  ],
  validateRequest,
  buildHeaders,
  buildResponseHeaders,
};
