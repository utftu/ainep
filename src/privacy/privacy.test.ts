import { describe, expect, test } from "bun:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

import { sanitizeBody } from "./privacy.ts";

const codecs = [
  { encoding: "identity", compress: (body: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> => body },
  { encoding: "gzip", compress: gzipSync },
  { encoding: "deflate", compress: deflateSync },
  { encoding: "br", compress: brotliCompressSync },
];

const base = { model: "test", messages: [{ role: "user", content: "hello" }], max_tokens: 100 };

async function validate(payload: unknown, route: "messages" | "count_tokens" = "messages"): Promise<number> {
  const result = await sanitizeBody({ body: Buffer.from(JSON.stringify(payload)), route, encoding: undefined, maxBodyBytes: 65536 });
  return "status" in result ? result.status : 200;
}

describe("strict protocol schemas", () => {
  test("preserves metadata and exact bytes through all codecs", async () => {
    const body = Buffer.from(JSON.stringify({ ...base, metadata: { user_id: JSON.stringify({ device_id: "fixture", session_id: "fixture" }) } }));
    for (const codec of codecs) {
      expect(await sanitizeBody({ body: codec.compress(body), route: "messages", encoding: codec.encoding, maxBodyBytes: 4096 })).toEqual({ body });
    }
  });

  test("rejects unknown fields at protocol boundaries", async () => {
    const cases = [
      { ...base, future: true },
      { ...base, metadata: { user_id: "original", future: "secret" } },
      { ...base, messages: [{ role: "user", content: "hello", future: true }] },
      { ...base, messages: [{ role: "user", content: [{ type: "unknown", text: "hello" }] }] },
      { ...base, messages: [{ role: "user", content: [{ type: "text", text: "hello", future: true }] }] },
      { ...base, system: [{ type: "text", text: "hello", cache_control: { type: "ephemeral", future: true } }] },
      { ...base, thinking: { type: "enabled", budget_tokens: 50, future: true } },
      { ...base, tools: [{ name: "Read", input_schema: { type: "object" }, future: true }] },
      { ...base, output_config: { effort: "high", future: true } },
      { ...base, context_management: { edits: [{ type: "future" }] } },
    ];
    for (const payload of cases) {
      expect(await validate(payload)).toBe(400);
    }
  });

  test("rejects invalid types, missing required fields and route mismatch", async () => {
    for (const payload of [{}, { ...base, max_tokens: "100" }, { ...base, max_tokens: -1 }, { ...base, stream: "true" }, { ...base, temperature: 2 }, { ...base, messages: [{ role: "system", content: "hello" }] }]) {
      expect(await validate(payload)).toBe(400);
    }
    expect(await validate({ model: "test", messages: [] }, "count_tokens")).toBe(200);
    expect(await validate(base, "count_tokens")).toBe(400);
    expect(await validate({ model: "test", messages: [] })).toBe(400);
  });

  test("preserves arbitrary tool data, JSON Schema and precise numbers without reserialization", async () => {
    const body = Buffer.from('{"model":"test","max_tokens":100,"tools":[{"name":"Read","input_schema":{"type":"object","properties":{"future":{"type":"number"}}}}],"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reasoning","signature":"original"},{"type":"tool_use","id":"tool1","name":"Read","input":{"future":9007199254740993,"huge":1e400,"zero":-0,"metadata":{"anything":true}}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool1","content":"hello"}]}]}');
    expect(await sanitizeBody({ body, route: "messages", encoding: undefined, maxBodyBytes: 4096 })).toEqual({ body });
  });

  test("keeps empty text valid but rejects null, missing text, array objects and prototype keys", async () => {
    expect(await validate({ ...base, messages: [{ role: "user", content: "" }] })).toBe(200);
    expect(await validate({ ...base, messages: [{ role: "user", content: [{ type: "text", text: "" }] }] })).toBe(200);
    expect(await validate({ ...base, metadata: { user_id: "" }, tools: [{ name: "Read", description: "", input_schema: { type: "object" } }] })).toBe(200);
    for (const payload of [
      { ...base, metadata: null },
      { ...base, metadata: [] },
      { ...base, metadata: { user_id: null } },
      { ...base, messages: [{ role: "user", content: [{ type: "text" }] }] },
      { ...base, messages: [{ role: "user", content: [{ type: "text", text: null }] }] },
      { ...base, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "id", name: "Read", input: [] }] }] },
      { ...base, output_config: [] },
      { ...base, output_config: { format: { type: "json_schema", schema: [] } } },
      { ...base, max_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, metadata: JSON.parse('{"constructor":"unexpected"}') },
      { ...base, metadata: JSON.parse('{"__proto__":"unexpected"}') },
    ]) {
      expect(await validate(payload)).toBe(400);
    }
    // Optional fields must not mutate reused schemas into accepting absent required fields.
    expect(await validate({ model: "test", messages: [] })).toBe(400);
  });


});

describe("decoding boundaries", () => {
  test("rejects unsupported and stacked encodings", async () => {
    for (const encoding of ["", "zstd", "gzip, br", "gzip, gzip"]) {
      const result = await sanitizeBody({ route: "messages", body: Buffer.from("{}"), encoding, maxBodyBytes: 100 });
      expect(result).toMatchObject({ status: 415 });
    }
  });

  test("rejects malformed JSON, invalid UTF-8 and non-object payloads", async () => {
    for (const body of [Buffer.from("broken"), Buffer.from("[]"), Buffer.from("null"), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])]) {
      const result = await sanitizeBody({ route: "messages", body, encoding: undefined, maxBodyBytes: 100 });
      expect(result).toMatchObject({ status: 400 });
    }
  });

  test("rejects corrupt and truncated compressed bodies", async () => {
    for (const codec of codecs.slice(1)) {
      const compressed = codec.compress(Buffer.from('{"metadata":{"user_id":"secret"}}'));
      for (const body of [Buffer.from("not-compressed"), compressed.subarray(0, compressed.length - 4)]) {
        const result = await sanitizeBody({ route: "messages", body, encoding: codec.encoding, maxBodyBytes: 1024 });
        expect(result).toMatchObject({ status: 400 });
      }
    }
  });

  test("limits decoded size before validating metadata, including compression bombs", async () => {
    const body = Buffer.from(JSON.stringify({ metadata: { user_id: "x".repeat(1024 * 1024) } }));
    for (const codec of codecs.slice(1)) {
      const result = await sanitizeBody({ route: "messages", body: codec.compress(body), encoding: codec.encoding, maxBodyBytes: 4096 });
      expect(result).toMatchObject({ status: 413 });
    }
  });

  test("enforces the decoded size limit across concatenated gzip members", async () => {
    const part = Buffer.from("x".repeat(800));
    const body = Buffer.concat([gzipSync(part), gzipSync(part)]);
    expect(await sanitizeBody({ route: "messages", body, encoding: "gzip", maxBodyBytes: 1024 })).toMatchObject({ status: 413 });
  });

  test("accepts the exact decoded limit and rejects one byte over", async () => {
    const body = Buffer.from(JSON.stringify({ model: "test", messages: [{ role: "user", content: "x".repeat(200) }], max_tokens: 1 }));
    for (const codec of codecs) {
      const compressed = codec.compress(body);
      expect(await sanitizeBody({ route: "messages", body: compressed, encoding: codec.encoding, maxBodyBytes: body.length })).toEqual({ body });
      expect(await sanitizeBody({ route: "messages", body: compressed, encoding: codec.encoding, maxBodyBytes: body.length - 1 })).toMatchObject({ status: 413 });
    }
  });
});
