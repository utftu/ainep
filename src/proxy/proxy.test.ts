import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { request } from "node:http";
import { gzipSync } from "node:zlib";

import { type ProxyOptions, startProxy } from "./proxy.ts";

const gatewayToken = "gateway-test-token-00000000000000000000";
const accessToken = "upstream-test-token-0000000000000000000";
const servers: Server<any>[] = [];

function startMock(handler: (req: Request) => Response | Promise<Response>): Server<undefined> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

function startGateway(upstream: Server<any>, options: Partial<ProxyOptions> = {}): Server<any> {
  const server = startProxy({ gatewayToken, upstreamOrigin: upstream.url.origin, port: 0, ...options });
  servers.push(server);
  return server;
}

async function send(gateway: Server<any>, options: { path?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
  return await fetch(new URL(options.path ?? "/v1/messages", gateway.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-gateway-token": gatewayToken, authorization: `Bearer ${accessToken}`, ...options.headers },
    body: options.body ?? '{"model":"test","messages":[],"max_tokens":1}',
    signal: options.signal ?? AbortSignal.timeout(2000),
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop(true);
  }
});

describe("proxy boundaries", () => {
  test("forwards exact JSON with client OAuth, strips client identity headers and response cookies", async () => {
    let received: { body: string; headers: Headers; url: string } | undefined;
    const upstream = startMock(async (req) => {
      received = { body: await req.text(), headers: req.headers, url: req.url };
      return Response.json({ input_tokens: 3 }, { headers: { "set-cookie": "secret=value", "request-id": "req_test" } });
    });
    const gateway = startGateway(upstream);
    const body = '{ "messages": [], "model": "test" }';
    const response = await send(gateway, {
      path: "/v1/messages/count_tokens?beta=true", body,
      headers: { "cookie": "private=value", "x-stainless-os": "Linux", "x-forwarded-for": "1.2.3.4", "anthropic-beta": "test-beta" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 3 });
    expect(received?.body).toBe(body);
    expect(received?.url).toBe(`${upstream.url.origin}/v1/messages/count_tokens?beta=true`);
    expect(received?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(received?.headers.get("anthropic-beta")).toBe("test-beta");
    for (const name of ["x-api-key", "x-gateway-token", "cookie", "x-stainless-os", "x-forwarded-for"]) {
      expect(received?.headers.get(name)).toBeNull();
    }
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("request-id")).toBe("req_test");
  });

  test("rejects missing, wrong and ambiguous credentials without upstream calls", async () => {
    let calls = 0;
    const gateway = startGateway(startMock(() => { calls++; return new Response("unexpected"); }));
    expect((await fetch(new URL("/v1/messages", gateway.url))).status).toBe(401);
    expect((await send(gateway, { headers: { "x-gateway-token": "wrong" } })).status).toBe(401);
    expect((await send(gateway, { headers: { authorization: `Bearer ${gatewayToken}` } })).status).toBe(401);
    expect(calls).toBe(0);
  });

  test("rejects malformed OAuth and ambiguous authorization without upstream calls", async () => {
    let calls = 0;
    const gateway = startGateway(startMock(() => { calls++; return new Response(); }));
    for (const authorization of ["", "Basic fixture", "Bearer short", `Bearer ${accessToken}, Bearer ${accessToken}`, `Bearer ${gatewayToken}`]) {
      expect((await send(gateway, { headers: { authorization } })).status).toBe(401);
    }
    expect((await send(gateway, { headers: { "x-api-key": "unexpected-api-key" } })).status).toBe(401);
    expect(calls).toBe(0);
  });

  test("forwards each request's current token without caching credentials", async () => {
    const received: string[] = [];
    const logs: unknown[] = [];
    const gateway = startGateway(startMock((req) => {
      received.push(req.headers.get("authorization")!);
      expect(req.headers.has("x-gateway-token")).toBe(false);
      return Response.json({ ok: true });
    }), { log: (event) => logs.push(event) });
    for (const token of [accessToken, `${accessToken}-rotated`]) {
      const response = await send(gateway, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(received).toEqual([`Bearer ${accessToken}`, `Bearer ${accessToken}-rotated`]);
    expect(JSON.stringify(logs)).not.toContain(accessToken);
    expect(JSON.stringify(logs)).not.toContain(gatewayToken);
  });

  test("schema failures and unknown API versions never reach upstream", async () => {
    let calls = 0;
    const gateway = startGateway(startMock(() => { calls++; return new Response(); }));
    for (const body of [
      '{"model":"test","messages":[],"max_tokens":1,"unknown":"secret"}',
      '{"model":"test","messages":[{"role":"user","content":[{"type":"future","data":"secret"}]}],"max_tokens":1}',
      '{"model":"test","messages":[],"max_tokens":1,"metadata":{"unknown":"secret"}}',
    ]) {
      const response = await send(gateway, { body });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("secret");
    }
    expect((await send(gateway, { headers: { "anthropic-version": "2099-01-01" } })).status).toBe(400);
    expect(calls).toBe(0);
  });

  test("rejects gateway Bearer without separate gateway authentication", async () => {
    const gateway = startGateway(startMock(() => Response.json({ ok: true })));
    const response = await fetch(new URL("/v1/messages", gateway.url), {
      method: "POST", headers: { authorization: `Bearer ${gatewayToken}`, "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(401);
    await response.text();
  });

  test("rejects unknown routes, methods and query parameters", async () => {
    let calls = 0;
    const gateway = startGateway(startMock(() => { calls++; return new Response(); }));
    for (const path of ["/api/event_logging/v2/batch", "/_health", "//example.invalid/v1/messages", "/v1/messages/"]) {
      const response = await fetch(`${gateway.url.origin}${path}`, { method: "POST", headers: { "x-gateway-token": gatewayToken, authorization: `Bearer ${accessToken}` } });
      expect(response.status).toBe(404);
    }
    expect((await fetch(new URL("/v1/messages", gateway.url), { headers: { "x-gateway-token": gatewayToken, authorization: `Bearer ${accessToken}` } })).status).toBe(404);
    for (const path of ["/v1/messages?target=https://example.invalid", "/v1/messages?beta=false", "/v1/messages?beta=true&beta=true"]) {
      expect((await send(gateway, { path })).status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  test("rejects corrupt compressed, invalid and non-object JSON before forwarding", async () => {
    let calls = 0;
    const gateway = startGateway(startMock(() => { calls++; return new Response(); }));
    expect((await send(gateway, { headers: { "content-encoding": "gzip" } })).status).toBe(400);
    expect((await send(gateway, { headers: { "content-type": "text/plain" } })).status).toBe(415);
    for (const body of ["broken", "null", "[]", "123"]) {
      expect((await send(gateway, { body })).status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  test("validates gzip requests on both routes and sends uncompressed JSON upstream", async () => {
    const received: { body: unknown; encoding: string | null }[] = [];
    const gateway = startGateway(startMock(async (req) => {
      received.push({ body: await req.json(), encoding: req.headers.get("content-encoding") });
      return Response.json({ ok: true });
    }));
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      const response = await fetch(new URL(path, gateway.url), {
        method: "POST",
        headers: { "x-gateway-token": gatewayToken, authorization: `Bearer ${accessToken}`, "content-type": "application/json", "content-encoding": "gzip" },
        body: gzipSync(Buffer.from(JSON.stringify(path.endsWith("count_tokens") ? { model: "test", messages: [] } : { model: "test", messages: [], max_tokens: 1, metadata: { user_id: "original" } }))),
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(received).toEqual([
      { body: { model: "test", messages: [], max_tokens: 1, metadata: { user_id: "original" } }, encoding: null },
      { body: { model: "test", messages: [] }, encoding: null },
    ]);
  });

  test("compressed oversized data never reaches upstream or logs", async () => {
    let calls = 0;
    const logs: unknown[] = [];
    const gateway = startGateway(startMock(() => { calls++; return new Response(); }), { maxBodyBytes: 1024, log: (event) => logs.push(event) });
    const response = await fetch(new URL("/v1/messages", gateway.url), {
      method: "POST",
      headers: { "x-gateway-token": gatewayToken, authorization: `Bearer ${accessToken}`, "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipSync(Buffer.from(JSON.stringify({ metadata: { user_id: "secret".repeat(10000) } }))),
    });
    expect(response.status).toBe(413);
    expect(calls).toBe(0);
    expect(JSON.stringify(logs)).not.toContain("secret");
    expect(await response.text()).not.toContain("secret");
  });

  test("limits fixed-length and chunked bodies", async () => {
    let calls = 0;
    const gateway = startGateway(startMock(() => { calls++; return new Response(); }), { maxBodyBytes: 64 });
    expect((await send(gateway, { body: JSON.stringify({ value: "x".repeat(100) }) })).status).toBe(413);
    const response = await fetch(new URL("/v1/messages", gateway.url), {
      method: "POST", headers: { "x-gateway-token": gatewayToken, authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: new ReadableStream({ start(controller): void { controller.enqueue(new TextEncoder().encode("x".repeat(100))); controller.close(); } }),
    });
    expect(response.status).toBe(413);
    expect(calls).toBe(0);
  });

  test("never follows redirects or discloses their location", async () => {
    let trapCalls = 0;
    const trap = startMock(() => { trapCalls++; return new Response("unexpected"); });
    const gateway = startGateway(startMock(() => Response.redirect(trap.url, 307)));
    const response = await send(gateway);
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(trapCalls).toBe(0);
  });

  test("absolute HTTP request target cannot change upstream", async () => {
    let trapCalls = 0;
    let upstreamCalls = 0;
    const trap = startMock(() => { trapCalls++; return new Response(); });
    const gateway = startGateway(startMock(() => { upstreamCalls++; return Response.json({ ok: true }); }));
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1", port: gateway.port, method: "POST", path: `${trap.url.origin}/v1/messages`,
        headers: { "x-gateway-token": gatewayToken, authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject);
      req.end('{"model":"test","messages":[],"max_tokens":1}');
    });
    expect(status).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(trapCalls).toBe(0);
  });

  test("returns upstream errors without logging body, credentials or query", async () => {
    const logs: unknown[] = [];
    const gateway = startGateway(startMock(() => Response.json({ error: "synthetic upstream error" }, { status: 429, headers: { "retry-after": "3" } })), { log: (event) => logs.push(event) });
    const response = await send(gateway, { path: "/v1/messages?beta=true" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toEqual({ error: "synthetic upstream error" });
    expect(logs).toEqual([{ route: "messages", status: 429, durationMs: expect.any(Number) }]);
  });

  test("refuses unsafe listener and upstream configuration", () => {
    for (const options of [
      { hostname: "0.0.0.0" },
      { upstreamOrigin: "http://example.invalid" },
      { upstreamOrigin: "https://user:password@example.invalid" },
      { upstreamOrigin: "https://example.invalid/path" },
      { upstreamOrigin: "https://example.invalid?query=value" },
      { gatewayToken: "short" },
    ]) {
      expect(() => startProxy({ gatewayToken, port: 0, ...options })).toThrow();
    }
  });
});

describe("stream lifecycle", () => {
  test("delivers the first SSE chunk before the upstream finishes", async () => {
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const gateway = startGateway(startMock(() => new Response(stream.readable, { headers: { "content-type": "text/event-stream" } })));
    const pending = send(gateway);
    const chunk = new TextEncoder().encode("event: message_start\ndata: {}\n\n");
    const written = writer.write(chunk);
    const response = await pending;
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(new TextDecoder().decode(chunk));
    await written;
    await writer.close();
    expect((await reader.read()).done).toBe(true);
  });

  test("times out an upstream that never responds", async () => {
    const gateway = startGateway(startMock(async (req) => await new Promise<Response>((resolve) => {
      req.signal.addEventListener("abort", () => resolve(new Response()), { once: true });
    })), { requestTimeoutMs: 30 });
    expect((await send(gateway)).status).toBe(504);
  });

  test("disconnecting the client aborts the upstream request", async () => {
    const disconnected = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const upstream = startMock(async (req) => {
      entered.resolve();
      return await new Promise<Response>((resolve) => {
        req.signal.addEventListener("abort", () => {
          disconnected.resolve();
          resolve(new Response());
        }, { once: true });
      });
    });
    const gateway = startGateway(upstream);
    const controller = new AbortController();
    const pending = send(gateway, { signal: controller.signal }).catch(() => undefined);
    await entered.promise;
    controller.abort();
    await pending;
    await disconnected.promise;
  });

  test("disconnecting during SSE closes the upstream connection", async () => {
    const disconnected = Promise.withResolvers<void>();
    const upstream = startMock((req) => {
      return new Response(new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
          req.signal.addEventListener("abort", () => {
            controller.close();
            disconnected.resolve();
          }, { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const gateway = startGateway(upstream);
    const controller = new AbortController();
    const response = await send(gateway, { signal: controller.signal });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await disconnected.promise;
  });

  test("the deadline remains active after SSE response headers", async () => {
    const upstream = startMock((req) => new Response(new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
        req.signal.addEventListener("abort", () => controller.close(), { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const gateway = startGateway(upstream, { requestTimeoutMs: 100 });
    const response = await send(gateway);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const result = await reader.read().catch(() => ({ done: true }));
    expect(result.done).toBe(true);
  });
});
