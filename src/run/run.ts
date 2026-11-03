import { constants } from "node:os";

export class RunConfigurationError extends Error {}

function parseOrigin(value: string | undefined, name: string): URL {
  if (!value) {
    throw new RunConfigurationError(`${name} is required. Run ainep --help.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RunConfigurationError(`${name} must be a valid origin.`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new RunConfigurationError(`${name} must be an HTTPS origin without credentials, path, query or fragment; HTTP is allowed only on loopback.`);
  }
  return url;
}

export function createClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const token = env.GATEWAY_TOKEN;
  if (!token || token.length < 32 || [...token].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) >= 127)) {
    throw new RunConfigurationError("GATEWAY_TOKEN must contain at least 32 printable ASCII characters without spaces.");
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new RunConfigurationError("TLS certificate verification must stay enabled.");
  }
  const gateway = parseOrigin(env.GATEWAY_URL, "GATEWAY_URL");
  const proxy = parseOrigin(env.CONNECT_PROXY_URL, "CONNECT_PROXY_URL");
  proxy.username = "ainep";
  proxy.password = encodeURIComponent(token);
  const client = { ...env };
  // Replace both casings so inherited bypass rules cannot override this launch.
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    client[name] = proxy.href;
  }
  client.NO_PROXY = [gateway.hostname, "localhost", "127.0.0.1", "::1"].join(",");
  client.no_proxy = client.NO_PROXY;
  client.ANTHROPIC_BASE_URL = `${gateway.origin}/claude`;
  client.ANTHROPIC_CUSTOM_HEADERS = `x-gateway-token: ${token}`;
  delete client.GATEWAY_TOKEN;
  delete client.GATEWAY_URL;
  delete client.CONNECT_PROXY_URL;
  return client;
}

export async function runClaude(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const client = createClientEnv(env);
  const executable = Bun.which("claude", { PATH: client.PATH ?? "" });
  if (executable === null) {
    throw new RunConfigurationError("Claude Code was not found in PATH. Install the native client first.");
  }
  let child: ReturnType<typeof Bun.spawn>;
  try {
    // No shell: arguments remain literal and the native client owns the terminal.
    child = Bun.spawn([executable, ...args], { env: client, stdio: ["inherit", "inherit", "inherit"] });
  } catch {
    throw new RunConfigurationError("Could not start Claude Code. Check executable permissions.");
  }
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map((signal) => {
    const handler = (): void => { child.kill(signal); };
    process.on(signal, handler);
    return handler;
  });
  try {
    const code = await child.exited;
    return child.signalCode === null ? code : 128 + constants.signals[child.signalCode];
  } finally {
    for (let i = 0; i < signals.length; i++) {
      process.off(signals[i]!, handlers[i]!);
    }
  }
}
