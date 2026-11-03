import { expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClientEnv } from "./run.ts";

const token = "fixture-gateway-secret-00000000:%@/#?";
const config = {
  GATEWAY_URL: "https://gateway.example:8443",
  CONNECT_PROXY_URL: "https://gateway.example:8444",
  GATEWAY_TOKEN: token,
};

test("client environment replaces conflicting routes without mutating the parent or OAuth", () => {
  const env = {
    ...config, NO_PROXY: "*", no_proxy: "*", https_proxy: "http://old.example",
    ANTHROPIC_CUSTOM_HEADERS: "x-old: value", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth",
  };
  const client = createClientEnv(env);
  expect(client.ANTHROPIC_BASE_URL).toBe("https://gateway.example:8443/claude");
  expect(client.ANTHROPIC_CUSTOM_HEADERS).toBe(`x-gateway-token: ${token}`);
  const proxy = new URL(client.HTTPS_PROXY!);
  expect(proxy.username).toBe("ainep");
  expect(decodeURIComponent(proxy.password)).toBe(token);
  expect(client.https_proxy).toBe(client.HTTPS_PROXY);
  expect(client.HTTP_PROXY).toBe(client.HTTPS_PROXY);
  expect(client.NO_PROXY).toBe("gateway.example,localhost,127.0.0.1,::1");
  expect(client.no_proxy).toBe(client.NO_PROXY);
  expect(client.CLAUDE_CODE_OAUTH_TOKEN).toBe("synthetic-oauth");
  expect(client.GATEWAY_TOKEN).toBeUndefined();
  expect(env.NO_PROXY).toBe("*");
  expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-old: value");
});

test("launcher rejects unsafe origins and TLS settings without exposing values", () => {
  for (const name of ["GATEWAY_URL", "CONNECT_PROXY_URL"]) {
    for (const value of [undefined, "not-an-origin", "http://remote.example", "https://secret@host.example", "https://host.example/claude", "https://host.example/?secret", "https://host.example/#secret"]) {
      expect(() => createClientEnv({ ...config, [name]: value })).toThrow(name);
    }
  }
  expect(() => createClientEnv({ ...config, GATEWAY_TOKEN: "short-secret" })).toThrow("at least 32");
  expect(() => createClientEnv({ ...config, NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toThrow("TLS certificate verification");
  expect(createClientEnv({ ...config, GATEWAY_URL: "http://127.0.0.1:8443", CONNECT_PROXY_URL: "http://[::1]:8444" }).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8443/claude");
});

async function createFixture(source: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ainep-run-"));
  await writeFile(join(cwd, "claude"), `#!${process.execPath}\n${source}`);
  await chmod(join(cwd, "claude"), 0o700);
  return cwd;
}

test("CLI passes literal arguments, cwd, stdin, stdout, stderr and exit code to the client", async () => {
  const cwd = await createFixture(`
const input = await Bun.stdin.text();
console.log(JSON.stringify({ args: Bun.argv.slice(2), input, cwd: process.cwd(), base: Bun.env.ANTHROPIC_BASE_URL }));
console.error("fixture-stderr");
process.exitCode = 23;
`);
  try {
    const args = ["--print", "space and $(not-a-command)", "--help"];
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../proxy/main.ts"), "run", "claude", ...args], {
      cwd, env: { ...config, PATH: cwd }, stdin: new Blob(["fixture-input"]), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(23);
    const result = JSON.parse(stdout);
    expect(result.args).toEqual(args);
    expect(result.input).toBe("fixture-input");
    expect(result.cwd).toBe(await realpath(cwd));
    expect(result.base).toBe("https://gateway.example:8443/claude");
    expect(stderr).toBe("fixture-stderr\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("CLI forwards termination signals and returns the signal exit code", async () => {
  const cwd = await createFixture('setInterval(() => {}, 1000); console.log("ready");');
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../proxy/main.ts"), "run", "claude"], {
    cwd, env: { ...config, PATH: cwd }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect((await reader.read()).done).toBe(true);
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    child.kill();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("CLI explains a missing native client without printing configuration secrets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ainep-run-"));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../proxy/main.ts"), "run", "claude"], {
      cwd, env: { ...config, PATH: cwd }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain("not found in PATH");
    expect(stderr).not.toContain(token);
    expect(stderr).not.toContain("gateway.example");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
