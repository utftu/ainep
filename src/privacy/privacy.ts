import { brotliDecompress, gunzip, inflate } from "node:zlib";

import { checkRequestSchema } from "./schema.ts";

export type PrivacyResult =
  | { body: Buffer<ArrayBuffer> }
  | { status: 400 | 413 | 415; message: string };

export type PrivacyInput = {
  body: Buffer<ArrayBuffer>;
  route: "messages" | "count_tokens";
  encoding: string | undefined;
  maxBodyBytes: number;
};

type Decompress = (
  body: Uint8Array,
  options: { maxOutputLength: number },
  callback: (error: Error | null, body: Buffer<ArrayBuffer>) => void,
) => void;

async function decompressBody(input: PrivacyInput): Promise<PrivacyResult> {
  if (input.body.length > input.maxBodyBytes) {
    return { status: 413, message: "Request body is too large" };
  }
  const encoding = input.encoding?.trim().toLowerCase() ?? "identity";
  if (encoding === "identity") {
    return { body: input.body };
  }
  const decompress: Decompress | undefined = encoding === "gzip" ? gunzip : encoding === "deflate" ? inflate : encoding === "br" ? brotliDecompress : undefined;
  if (decompress === undefined) {
    return { status: 415, message: "Unsupported content encoding" };
  }

  // Bound allocation inside the decompressor, before a compressed bomb can expand in memory.
  return await new Promise<PrivacyResult>((resolve) => {
    decompress(input.body, { maxOutputLength: input.maxBodyBytes }, (error, body) => {
      if (error !== null) {
        const oversized = (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
        resolve({ status: oversized ? 413 : 400, message: oversized ? "Decoded body is too large" : "Invalid compressed body" });
        return;
      }
      resolve({ body });
    });
  });
}

export async function sanitizeBody(input: PrivacyInput): Promise<PrivacyResult> {
  const decoded = await decompressBody(input);
  if ("status" in decoded) {
    return decoded;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded.body);
    const payload: unknown = JSON.parse(text);
    if (!checkRequestSchema(payload, input.route)) {
      return { status: 400, message: "Unsupported request schema" };
    }
    // Validate without reserializing: preserve identifiers, signatures and exact numeric payloads.
    return decoded;
  } catch {
    // Never fall back to the original body when decoding or JSON processing fails.
    return { status: 400, message: "Invalid UTF-8 or JSON body" };
  }
}
