import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import { startConnectProxy } from "../connect/connect.ts";
import { startProxy } from "../proxy/proxy.ts";

type Capture = {
  stage: "client" | "upstream";
  auth: { bearerMatchesFixture: boolean; gatewayMatchesFixture: boolean };
  route: string;
  queryKeys: string[];
  headers: string[];
  encoding: string;
  bodyBytes: number;
  fields: string[];
  metadata: unknown;
  stream: boolean;
  toolResult: boolean;
  fixtureRead: boolean;
};

type Scenario = {
  name: string;
  bare: boolean;
  tool: boolean;
  resume?: string;
  throughProxy?: boolean;
  oauth?: boolean;
  storedOauth?: boolean;
  refresh?: boolean;
};

type ScenarioResult = {
  name: string;
  skipped?: string;
  exitCode?: number;
  success: boolean;
  stderrBytes?: number;
  requests?: Capture[];
  connectDestinations?: string[];
};

export type AuditReport = {
  version: string;
  binarySha256: string;
  isolation: Record<string, boolean>;
  authMode: string;
  scenarios: ScenarioResult[];
  limitations: string[];
};

function quoteProfile(value: string): string {
  return JSON.stringify(value);
}

function createProfile(options: { root: string; binary: string; port: number; connectPort: number }): string {
  // Only the mock API and authenticated fixture proxy ports are reachable.
  return `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:${options.port}") (remote ip "localhost:${options.connectPort}"))
(deny file-read*
  (subpath "/Users") (subpath ${quoteProfile(homedir())}) (subpath "/Volumes")
  (subpath "/Library/Keychains") (subpath "/Library/Application Support/ClaudeCode")
  (subpath "/private/var/folders") (subpath "/private/tmp"))
(allow file-read* (literal ${quoteProfile(options.binary)}) (subpath ${quoteProfile(options.root)}))
(deny file-write*)
(allow file-write* (subpath ${quoteProfile(options.root)}) (literal "/dev/null"))
(deny mach-lookup
  (global-name "com.apple.securityd") (global-name "com.apple.secd")
  (global-name "com.apple.security.agent"))`;
}

function describeValue(value: unknown, depth = 0): unknown {
  if (value === null) {
    return { type: "null" };
  }
  if (typeof value === "string") {
    // Reveal schema, not identifiers. user_id sometimes contains a second JSON document.
    if (depth < 3 && value.startsWith("{")) {
      try {
        return { type: "json-string", fields: describeValue(JSON.parse(value), depth + 1) };
      } catch {}
    }
    return { type: "string", length: value.length };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, items: depth < 8 ? value.slice(0, 3).map((item) => describeValue(item, depth + 1)) : undefined };
  }
  if (typeof value === "object" && depth < 8) {
    const fields: Record<string, unknown> = {};
    for (const key in value) {
      Object.defineProperty(fields, key, { value: describeValue((value as Record<string, unknown>)[key], depth + 1), enumerable: true });
    }
    return fields;
  }
  return { type: typeof value };
}

function decodeBody(body: Buffer<ArrayBuffer>, encoding: string): Buffer<ArrayBuffer> {
  const options = { maxOutputLength: 16 * 1024 * 1024 };
  if (encoding === "gzip") {
    return gunzipSync(body, options);
  }
  if (encoding === "br") {
    return brotliDecompressSync(body, options);
  }
  if (encoding === "deflate") {
    return inflateSync(body, options);
  }
  if (encoding !== "identity") {
    throw new Error("Unsupported mock request encoding");
  }
  return body;
}

function createMockResponse(options: { stream: boolean; tool: boolean; fixture: string; model: string }): Response {
  const block = options.tool
    ? { type: "tool_use", id: "toolu_audit_fixture", name: "Read", input: { file_path: options.fixture } }
    : { type: "text", text: "AUDIT_OK" };
  const reason = options.tool ? "tool_use" : "end_turn";
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id: "msg_audit_fixture", type: "message", role: "assistant", model: options.model, content: [block], stop_reason: reason, stop_sequence: null, usage };
  if (!options.stream) {
    return Response.json(message);
  }
  const start = options.tool ? { ...block, input: {} } : { type: "text", text: "" };
  const delta = options.tool
    ? { type: "input_json_delta", partial_json: JSON.stringify({ file_path: options.fixture }) }
    : { type: "text_delta", text: "AUDIT_OK" };
  const events = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: start },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "request-id": "req_audit_fixture" },
  });
}

function captureRequest(options: { req: Request; bytes: Buffer<ArrayBuffer>; stage: Capture["stage"] }): { capture: Capture; payload: any } {
  const url = new URL(options.req.url);
  const encoding = options.req.headers.get("content-encoding") ?? "identity";
  const payload = options.bytes.length === 0 ? {} : JSON.parse(decodeBody(options.bytes, encoding).toString());
  let toolResult = false;
  let fixtureRead = false;
  for (const message of payload.messages ?? []) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_result") {
        toolResult = true;
        if (!block.is_error && JSON.stringify(block.content).includes("AUDIT_FIXTURE_ONLY")) {
          fixtureRead = true;
        }
      }
    }
  }
  return {
    payload,
    capture: {
      auth: { bearerMatchesFixture: options.req.headers.get("authorization") === "Bearer sk-ant-oat01-audit-fake-0000000000000000000000000000", gatewayMatchesFixture: options.req.headers.get("x-gateway-token") === "audit-gateway-fake-0000000000000000000000" },
      stage: options.stage, route: url.pathname, queryKeys: [...url.searchParams.keys()],
      headers: [...options.req.headers.keys()], encoding, bodyBytes: options.bytes.length,
      fields: Object.keys(payload), metadata: describeValue(payload.metadata),
      stream: payload.stream === true, toolResult, fixtureRead,
    },
  };
}

async function runChild(options: { profile: string; root: string; args: string[]; env: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", options.profile, ...options.args], {
    cwd: options.root, env: options.env, stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

export async function runAudit(binaryPath: string): Promise<AuditReport> {
  if (process.platform !== "darwin") {
    throw new Error("This audit runner requires macOS sandbox-exec");
  }
  const binary = await realpath(binaryPath);
  const root = await realpath(await mkdtemp("/tmp/cca-"));
  await mkdir(join(root, "config"));
  const fixture = join(root, "fixture.txt");
  await writeFile(fixture, "AUDIT_FIXTURE_ONLY\n", { mode: 0o600 });
  const captures: Capture[] = [];
  let active: Scenario = { name: "preflight", bare: true, tool: false };
  let issuedTool = false;
  const fakeKey = "sk-ant-api03-audit-fake-0000000000000000000000000000";
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(req): Promise<Response> {
      const { capture, payload } = captureRequest({ req, bytes: Buffer.from(await req.arrayBuffer()), stage: "upstream" });
      captures.push(capture);
      const tool = active.tool && !issuedTool;
      issuedTool = true;
      return createMockResponse({ stream: payload.stream === true, tool, fixture, model: payload.model });
    },
  });
  const proxy = startProxy({ gatewayToken: "audit-gateway-fake-0000000000000000000000", port: 0, upstreamOrigins: { claude: upstream.url.origin } });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/_probe") {
        return new Response("AUDIT_LOOPBACK_OK");
      }
      const bytes = Buffer.from(await req.arrayBuffer());
      const { capture, payload } = captureRequest({ req, bytes, stage: "client" });
      captures.push(capture);
      if (active.throughProxy) {
        const response = await fetch(new URL(url.pathname + url.search, proxy.url), {
          method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : bytes,
          redirect: "manual", signal: AbortSignal.any([req.signal, AbortSignal.timeout(15000)]),
        });
        return new Response(response.body, { status: response.status, headers: response.headers });
      }
      if (url.pathname === "/claude/v1/messages/count_tokens") {
        return Response.json({ input_tokens: 10 });
      }
      if (url.pathname !== "/claude/v1/messages") {
        return Response.json({ error: { type: "not_found_error", message: "Mock route unavailable" } }, { status: 404 });
      }
      const tool = active.tool && !issuedTool;
      issuedTool = true;
      return createMockResponse({ stream: payload.stream === true, tool, fixture, model: payload.model });
    },
    error(): Response { return new Response("Invalid mock request", { status: 400 }); },
  });
  const connectDestinations: string[] = [];
  const tunnel = await startConnectProxy({
    gatewayToken: "audit-gateway-fake-0000000000000000000000", port: 0,
    openConnection(hostname, port): Socket {
      connectDestinations.push(`${hostname}:${port}`);
      const socket = new Socket();
      queueMicrotask(() => socket.destroy());
      return socket;
    },
  });
  const profile = createProfile({ root, binary, port: server.port!, connectPort: Number(new URL(tunnel.url).port) });
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: root, CLAUDE_CODE_TMPDIR: root, CLAUDE_CONFIG_DIR: join(root, "config"),
    ANTHROPIC_API_KEY: fakeKey,
    ANTHROPIC_BASE_URL: `${server.url.origin}/claude`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    CLAUDE_CODE_MAX_RETRIES: "0", API_TIMEOUT_MS: "10000", TERM: "dumb", LANG: "en_US.UTF-8",
  };
  try {
    // No actual internet endpoint is contacted: blocked egress is tested against another local port.
    const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("UNEXPECTED") });
    const allowed = await runChild({ profile, root, env, args: ["/usr/bin/curl", "--noproxy", "*", "-fsS", "--max-time", "3", `${server.url.origin}/_probe`] });
    const blocked = await runChild({ profile, root, env, args: ["/usr/bin/curl", "--noproxy", "*", "-fsS", "--max-time", "3", trap.url.origin] });
    await trap.stop(true);
    // A synthetic file outside the task directory verifies file isolation without reading credentials.
    const sentinelRoot = await realpath(await mkdtemp("/tmp/claude-anon-sentinel-"));
    await writeFile(join(sentinelRoot, "sentinel"), "SYNTHETIC_PRIVATE_FILE", { mode: 0o600 });
    const denied = await runChild({ profile, root, env, args: ["/bin/cat", join(sentinelRoot, "sentinel")] });
    await rm(sentinelRoot, { recursive: true, force: true });
    if (allowed.code !== 0 || allowed.stdout !== "AUDIT_LOOPBACK_OK" || blocked.code === 0 || denied.code === 0) {
      throw new Error(`Sandbox preflight failed; Claude was not launched (${allowed.code}/${blocked.code}/${denied.code})`);
    }
    const version = await runChild({ profile, root, env, args: [binary, "--version"] });
    const scenarios: Scenario[] = [
      { name: "oauth-refresh-connect-outage", bare: false, tool: false, oauth: true, storedOauth: true, refresh: true },
      { name: "stored-oauth-custom-origin", bare: false, tool: false, oauth: true, storedOauth: true },
      { name: "oauth-custom-origin", bare: false, tool: false, oauth: true },
      { name: "bare-message", bare: true, tool: false },
      { name: "bare-read-tool", bare: true, tool: true },
      { name: "bare-resume", bare: true, tool: false },
      { name: "isolated-standard", bare: false, tool: false },
      { name: "proxied-read-tool", bare: false, tool: true, throughProxy: true, oauth: true, storedOauth: true },
      { name: "proxied-resume", bare: false, tool: false, throughProxy: true, oauth: true, storedOauth: true },
    ];
    const results: ScenarioResult[] = [];
    let session: string | undefined;
    for (const scenario of scenarios) {
      active = scenario;
      issuedTool = false;
      const start = captures.length;
      if (scenario.name.endsWith("resume")) {
        scenario.resume = session;
        if (session === undefined) {
          results.push({ name: scenario.name, success: false, skipped: "No session to resume" });
          continue;
        }
      }
      const args = [binary, "-p", "--output-format", "json", "--model", "claude-sonnet-4-5", "--max-turns", "4", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", scenario.tool ? "Read" : "", "--allowedTools", "Read"];
      args.push(scenario.bare ? "--bare" : "--safe-mode");
      if (scenario.resume !== undefined) {
        args.push("--resume", scenario.resume);
      }
      args.push("--", scenario.tool ? "Read fixture.txt and reply AUDIT_OK." : "Reply AUDIT_OK.");
      const scenarioEnv: Record<string, string> = { ...env };
      if (scenario.oauth) {
        delete scenarioEnv.ANTHROPIC_API_KEY;
        if (scenario.storedOauth) {
          await writeFile(join(root, "config", ".credentials.json"), JSON.stringify({ claudeAiOauth: {
            accessToken: "sk-ant-oat01-audit-fake-0000000000000000000000000000",
            refreshToken: "sk-ant-ort01-audit-fake-0000000000000000000000000000",
            expiresAt: Date.now() + (scenario.refresh ? -3600000 : 3600000),
            scopes: ["user:inference", "user:profile"], subscriptionType: "max",
          } }), { mode: 0o600 });
        } else {
          scenarioEnv.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-audit-fake-0000000000000000000000000000";
        }
        scenarioEnv.ANTHROPIC_CUSTOM_HEADERS = "x-gateway-token: audit-gateway-fake-0000000000000000000000";
      }
      if (scenario.refresh) {
        const proxyUrl = new URL(tunnel.url);
        proxyUrl.username = "ainep";
        proxyUrl.password = "audit-gateway-fake-0000000000000000000000";
        scenarioEnv.HTTPS_PROXY = proxyUrl.href;
        scenarioEnv.NO_PROXY = "127.0.0.1,localhost";
      }
      const result = await runChild({ profile, root, env: scenarioEnv, args });
      await rm(join(root, "config", ".credentials.json"), { force: true });
      const parsed = await new Response(result.stdout).json().catch(() => undefined);
      if (scenario.tool && typeof parsed?.session_id === "string") {
        session = parsed.session_id;
      }
      const requests = captures.slice(start);
      const toolVerified = !scenario.tool || requests.some((capture) => capture.fixtureRead);
      const resumeVerified = scenario.resume === undefined || (parsed?.session_id === scenario.resume && requests.some((capture) => capture.fixtureRead));
      const upstreamRequests = requests.filter((capture) => capture.stage === "upstream");
      const forwardingVerified = !scenario.throughProxy || (upstreamRequests.length > 0 && upstreamRequests.every((capture) => capture.fields.includes("metadata") && capture.auth.bearerMatchesFixture && !capture.headers.includes("x-gateway-token") && !capture.headers.includes("x-claude-code-session-id") && !capture.headers.includes("x-api-key")));
      results.push({
        name: scenario.name, exitCode: result.code,
        success: scenario.refresh ? connectDestinations.includes("platform.claude.com:443") : result.code === 0 && parsed?.result === "AUDIT_OK" && parsed?.is_error === false && toolVerified && resumeVerified && forwardingVerified && (!scenario.oauth || requests.some((capture) => capture.route === "/claude/v1/messages" && capture.auth.bearerMatchesFixture && capture.auth.gatewayMatchesFixture)),
        stderrBytes: Buffer.byteLength(result.stderr), requests,
        connectDestinations: scenario.refresh ? [...connectDestinations] : undefined,
      });
    }
    return {
      version: version.code === 0 ? version.stdout.trim() : "unavailable",
      binarySha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
      isolation: { allowedMockPort: true, blockedOtherPort: true, blockedExternalFixture: true, keychainMachServicesDenied: true },
      authMode: "synthetic-api-key-and-oauth", scenarios: results,
      limitations: ["Synthetic OAuth only; no real account or Anthropic server compatibility test", "Stored OAuth uses a temporary credentials file; real Keychain is inaccessible", "Refresh CONNECT routing tested with intentional 502; successful refresh and browser login not tested", "No capture of blocked destination attempts", "OAuth scenarios use safe-mode and disabled telemetry", "Metadata schema only; identifiers and prompts are not saved"],
    };
  } finally {
    await tunnel.close();
    await server.stop(true);
    await proxy.stop(true);
    await upstream.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
