import { afterEach, expect, test } from "bun:test";
import { connect, createServer, Socket } from "node:net";

import { startConnectProxy, type ConnectProxy } from "./connect.ts";

const token = "connect-fixture-token-0000000000000000000000";
const authorization = `Basic ${Buffer.from(`ainep:${token}`).toString("base64")}`;
const proxies: ConnectProxy[] = [];

async function start(openConnection?: (hostname: string, port: number) => Socket): Promise<ConnectProxy> {
  const proxy = await startConnectProxy({ gatewayToken: token, port: 0, openConnection });
  proxies.push(proxy);
  return proxy;
}

async function exchange(proxy: ConnectProxy, request: string, expected: string, payload?: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = connect(Number(new URL(proxy.url).port), "127.0.0.1", () => socket.write(request));
    let output = "";
    socket.setTimeout(2000, () => socket.destroy(new Error("Fixture timed out")));
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      output += chunk.toString();
      if (payload !== undefined && output.includes("200 Connection Established\r\n\r\n")) {
        socket.write(payload);
        payload = undefined;
      }
      if (output.includes(expected)) {
        socket.destroy();
        resolve(output);
      }
    });
    socket.on("end", () => resolve(output));
  });
}

function request(target: string, auth = authorization): string {
  return `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`;
}

afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    await proxy.close();
  }
});

test("rejects unauthorized and forbidden destinations before dialing", async () => {
  let calls = 0;
  const proxy = await start(() => { calls++; throw new Error("Unexpected dial"); });
  for (const auth of ["", "Basic invalid", `Bearer ${token}`]) {
    expect(await exchange(proxy, request("platform.claude.com:443", auth), "\r\n\r\n")).toContain("407");
  }
  for (const target of ["api.anthropic.com:443", "127.0.0.1:443", "platform.claude.com:80", "platform.claude.com:443/path", "platform.claude.com.evil.invalid:443", "https://platform.claude.com:443", "user@platform.claude.com:443"]) {
    expect(await exchange(proxy, request(target), "\r\n\r\n")).toContain("403");
  }
  expect(calls).toBe(0);
});

test("does not act as a general HTTP forward proxy", async () => {
  const proxy = await start();
  expect(await exchange(proxy, "GET http://example.invalid/ HTTP/1.1\r\nHost: example.invalid\r\n\r\n", "\r\n\r\n")).toContain("405");
});

test("tunnels raw bytes without forwarding proxy credentials, after the CONNECT handshake", async () => {
  let received = "";
  const echo = createServer((socket) => {
    socket.on("data", (chunk) => { received += chunk.toString(); socket.write(chunk); });
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const address = echo.address() as { port: number };
  try {
    const proxy = await start((hostname, port) => {
      expect(hostname).toBe("platform.claude.com");
      expect(port).toBe(443);
      return connect(address.port, "127.0.0.1");
    });
    const response = await exchange(proxy, request("platform.claude.com:443"), "FIXTURE_TLS_BYTES", "FIXTURE_TLS_BYTES");
    expect(response).toContain("200 Connection Established");
    expect(received).toBe("FIXTURE_TLS_BYTES");
    expect(response).not.toContain(token);
    await proxy.close();
  } finally {
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  }
});

test("upstream failure returns 502 without destination or credentials", async () => {
  const proxy = await start(() => {
    const socket = new Socket();
    queueMicrotask(() => socket.destroy());
    return socket;
  });
  const response = await exchange(proxy, request("platform.claude.com:443"), "\r\n\r\n");
  expect(response).toContain("502");
  expect(response).not.toContain(token);
  expect(response).not.toContain("platform.claude.com");
});

test("external listeners require TLS and valid configuration", async () => {
  await expect(startConnectProxy({ gatewayToken: token, hostname: "0.0.0.0" })).rejects.toThrow("TLS");
  await expect(startConnectProxy({ gatewayToken: "short" })).rejects.toThrow("GATEWAY_TOKEN");
  await expect(startConnectProxy({ gatewayToken: token, port: -1 })).rejects.toThrow("port");
});
