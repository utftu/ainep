#!/usr/bin/env bun
import { readFileSync } from "node:fs";

import { version } from "../../package.json";

import { startProxy } from "./proxy.ts";

function main(): void {
  const args = Bun.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(`Usage: ainep [--help | --version]

Start the gateway using environment variables:
  GATEWAY_TOKEN   Required gateway access token (at least 32 characters)
  GATEWAY_HOST    Listener address (default: 127.0.0.1)
  GATEWAY_PORT    Listener port (default: 8443)
  TLS_CERT_FILE  TLS certificate path (required for non-loopback listeners)
  TLS_KEY_FILE   TLS private key path (required for non-loopback listeners)

Requires Bun >=1.3.0. OAuth refresh and CONNECT tunneling are not included.`);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    console.log(version);
    return;
  }
  if (args.length !== 0) {
    console.error("Unsupported arguments. Run ainep --help.");
    process.exitCode = 1;
    return;
  }

  const cert = Bun.env.TLS_CERT_FILE;
  const key = Bun.env.TLS_KEY_FILE;
  if ((cert === undefined) !== (key === undefined)) {
    throw new Error("TLS_CERT_FILE and TLS_KEY_FILE must be set together");
  }

  const server = startProxy({
    gatewayToken: Bun.env.GATEWAY_TOKEN ?? "",
    hostname: Bun.env.GATEWAY_HOST ?? "127.0.0.1",
    port: Number(Bun.env.GATEWAY_PORT ?? "8443"),
    tls: cert !== undefined && key !== undefined ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined,
    log: (event) => console.log(JSON.stringify(event)),
  });
  console.log(`Proxy listening on ${server.url.origin}`);
}

try {
  main();
} catch {
  // Startup failures must not dump environment values or secret file contents.
  console.error("Proxy startup failed. Check credentials, listener and TLS configuration in README.md.");
  process.exitCode = 1;
}
