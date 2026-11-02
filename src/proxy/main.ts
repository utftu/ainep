#!/usr/bin/env bun
import { readFileSync } from "node:fs";

import { version } from "../../package.json";

import { ConnectConfigurationError, startConnectProxy } from "../connect/connect.ts";

import { ProxyConfigurationError, startProxy } from "./proxy.ts";

function readTlsFile(path: string, variable: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new ProxyConfigurationError(`Cannot read ${variable}. Check the file path and permissions.`);
  }
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(`Usage: ainep [connect | --help | --version]

Start the gateway. Available provider: /claude

Configure Claude Code: ANTHROPIC_BASE_URL=https://your-gateway/claude

Environment variables:
  GATEWAY_TOKEN   Required gateway access token (at least 32 characters)
  GATEWAY_HOST    Listener address (default: 127.0.0.1)
  GATEWAY_PORT    Listener port (default: 8443; connect: 8444)
  TLS_CERT_FILE  TLS certificate path (required for non-loopback listeners)
  TLS_KEY_FILE   TLS private key path (required for non-loopback listeners)

Run ainep connect as a separate process for authenticated OAuth CONNECT tunnels.
Proxy username: ainep; password: GATEWAY_TOKEN. Requires Bun >=1.3.0.`);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    console.log(version);
    return;
  }
  if (args.length !== 0 && !(args.length === 1 && args[0] === "connect")) {
    console.error("Unsupported arguments. Run ainep --help.");
    process.exitCode = 1;
    return;
  }

  if (!Bun.env.GATEWAY_TOKEN) {
    throw new ProxyConfigurationError("GATEWAY_TOKEN is required. Generate one with: openssl rand -hex 32. Set it in the environment or a .env file in the working directory.");
  }
  const cert = Bun.env.TLS_CERT_FILE;
  const key = Bun.env.TLS_KEY_FILE;
  if ((cert === undefined) !== (key === undefined)) {
    throw new ProxyConfigurationError("TLS_CERT_FILE and TLS_KEY_FILE must be set together");
  }

  const tls = cert !== undefined && key !== undefined ? { cert: readTlsFile(cert, "TLS_CERT_FILE"), key: readTlsFile(key, "TLS_KEY_FILE") } : undefined;
  if (args[0] === "connect") {
    const server = await startConnectProxy({
      gatewayToken: Bun.env.GATEWAY_TOKEN!,
      hostname: Bun.env.GATEWAY_HOST ?? "127.0.0.1",
      port: Number(Bun.env.GATEWAY_PORT ?? "8444"),
      tls,
    });
    console.log(`CONNECT proxy listening on ${server.url}`);
    return;
  }
  const server = startProxy({
    gatewayToken: Bun.env.GATEWAY_TOKEN ?? "",
    hostname: Bun.env.GATEWAY_HOST ?? "127.0.0.1",
    port: Number(Bun.env.GATEWAY_PORT ?? "8443"),
    tls,
    log: (event) => console.log(JSON.stringify(event)),
  });
  console.log(`Proxy listening on ${server.url.origin}`);
}

try {
  await main();
} catch (error) {
  // Startup failures must not dump environment values or secret file contents.
  if (error instanceof ProxyConfigurationError || error instanceof ConnectConfigurationError) {
    console.error(`Proxy startup failed: ${error.message}`);
  } else if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    console.error("Proxy startup failed: GATEWAY_PORT is already in use. Choose another port.");
  } else {
    console.error("Proxy startup failed. Check listener permissions and TLS certificate/key validity. Run ainep --help for configuration.");
  }
  process.exitCode = 1;
}
