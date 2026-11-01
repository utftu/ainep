import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runCli(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "ainep-cli-"));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
      cwd, env, stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, stderr };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("CLI explains missing gateway configuration", async () => {
  const result = await runCli({});
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("GATEWAY_TOKEN is required");
  expect(result.stderr).toContain("openssl rand -hex 32");
});

test("CLI explains invalid token without exposing it", async () => {
  const result = await runCli({ GATEWAY_TOKEN: "private-short-token" });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("at least 32");
  expect(result.stderr).not.toContain("private-short-token");
});

test("CLI explains missing TLS pair without exposing file paths or tokens", async () => {
  const token = "fixture-gateway-secret-000000000000000000";
  const result = await runCli({ GATEWAY_TOKEN: token, TLS_CERT_FILE: "/synthetic/private-cert.pem" });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("TLS_CERT_FILE and TLS_KEY_FILE must be set together");
  expect(result.stderr).not.toContain(token);
  expect(result.stderr).not.toContain("/synthetic/");
});
