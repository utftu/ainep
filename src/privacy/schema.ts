import { d, type Schema } from "desy";

function createObject(fields: Record<string, Schema<any>>): ReturnType<typeof d.object> {
  // desy accepts arrays as objects and uses `in` for keys; guard arrays and remove the shape prototype.
  const shape = Object.assign(Object.create(null), fields);
  const schema = d.mixed();
  schema.test((value) => Array.isArray(value) ? "Expected an object" : "");
  return schema.object(shape);
}

function allowAbsent(schema: Schema<any>): Schema<any> {
  // desy mutates schemas: wrap reusable schemas before changing their optionality.
  return d.mixed().oneOf([schema]).undefinable();
}

// allowEmpty also allows null/undefined in desy; the outer schema keeps text required and non-null.
const text = d.mixed().notVoid().oneOf([d.string().allowEmpty()]);
const name = d.string().max(256);
const integer = d.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const probability = d.number().min(0).max(1);
const payloadObject = createObject({}).loose();
const cacheControl = createObject({
  type: d.string().oneOf(["ephemeral"]),
  ttl: d.string().oneOf(["5m", "1h"]).undefinable(),
  scope: d.string().oneOf(["global", "session"]).undefinable(),
});
const cached = { cache_control: allowAbsent(cacheControl) };
const textBlock = createObject({ type: d.string().oneOf(["text"]), text, ...cached });
const imageSource = d.mixed().oneOf([
  createObject({
    type: d.string().oneOf(["base64"]),
    media_type: d.string().oneOf(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    data: text,
  }),
  createObject({ type: d.string().oneOf(["url"]), url: text }),
]);
const imageBlock = createObject({ type: d.string().oneOf(["image"]), source: imageSource, ...cached });
const resultContent = d.mixed().oneOf([text, d.array(d.mixed().oneOf([textBlock, imageBlock]))]);
const block = d.mixed().oneOf([
  textBlock,
  imageBlock,
  createObject({ type: d.string().oneOf(["thinking"]), thinking: text, signature: text }),
  createObject({ type: d.string().oneOf(["redacted_thinking"]), data: text }),
  createObject({ type: d.string().oneOf(["tool_use"]), id: name, name, input: payloadObject, ...cached }),
  createObject({
    type: d.string().oneOf(["tool_result"]), tool_use_id: name,
    content: allowAbsent(resultContent), is_error: d.boolean().undefinable(), ...cached,
  }),
]);
const message = createObject({
  role: d.string().oneOf(["user", "assistant"]),
  content: d.mixed().oneOf([text, d.array(block)]),
});
const tool = createObject({
  name,
  input_schema: createObject({ type: d.string().oneOf(["object"]) }).loose(),
  description: allowAbsent(text),
  type: d.string().oneOf(["custom"]).undefinable(),
  strict: d.boolean().undefinable(),
  defer_loading: d.boolean().undefinable(),
  ...cached,
});
const toolChoice = d.mixed().oneOf([
  createObject({ type: d.string().oneOf(["auto", "any"]), disable_parallel_tool_use: d.boolean().undefinable() }),
  createObject({ type: d.string().oneOf(["tool"]), name, disable_parallel_tool_use: d.boolean().undefinable() }),
  createObject({ type: d.string().oneOf(["none"]) }),
]);
const thinking = d.mixed().oneOf([
  createObject({ type: d.string().oneOf(["enabled"]), budget_tokens: integer, display: d.string().oneOf(["summarized", "omitted"]).undefinable() }),
  createObject({ type: d.string().oneOf(["adaptive"]), display: d.string().oneOf(["summarized", "omitted"]).undefinable() }),
  createObject({ type: d.string().oneOf(["disabled"]) }),
]);
const contextManagement = createObject({
  edits: d.array(createObject({
    type: d.string().oneOf(["clear_thinking_20251015"]),
    keep: d.mixed().oneOf([
      d.string().oneOf(["all"]),
      createObject({ type: d.string().oneOf(["thinking_turns"]), value: integer }),
    ]).undefinable(),
  })),
});
const shared = {
  system: d.mixed().oneOf([text, d.array(textBlock)]).undefinable(),
  tools: d.array(tool).undefinable(),
  tool_choice: allowAbsent(toolChoice),
  thinking: allowAbsent(thinking),
  context_management: allowAbsent(contextManagement),
};
const generation = createObject({
  model: name, messages: d.array(message), max_tokens: integer,
  ...shared,
  metadata: createObject({ user_id: allowAbsent(text) }).undefinable(),
  stream: d.boolean().undefinable(),
  temperature: allowAbsent(probability),
  top_p: allowAbsent(probability),
  top_k: allowAbsent(integer),
  stop_sequences: d.array(text).undefinable(),
  service_tier: d.string().oneOf(["auto", "standard_only"]).undefinable(),
  cache_control: allowAbsent(cacheControl),
  output_config: createObject({
    effort: d.string().oneOf(["low", "medium", "high", "max"]).undefinable(),
    format: createObject({ type: d.string().oneOf(["json_schema"]), schema: payloadObject }).undefinable(),
  }).undefinable(),
});
const counting = createObject({ model: name, messages: d.array(message), ...shared });

export function checkRequestSchema(value: unknown, route: "messages" | "count_tokens"): boolean {
  return (route === "messages" ? generation : counting).validate(value) === "";
}
