import test from "node:test";
import assert from "node:assert/strict";

import {
  HuggingChatStreamError,
  MAX_JSONL_RESPONSE_BYTES,
  readJsonlResponse,
  streamJsonlToOpenAi,
} from "../../open-sse/executors/huggingchat/jsonlStream.ts";

const enc = new TextEncoder();

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(enc.encode(part));
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

test("non-stream JSONL assembles token fragments once", async () => {
  const body = streamOf(
    '{"type":"stream","token":"hello "}\n',
    '{"type":"stream","token":"world"}\n',
    '{"type":"status","status":"finished"}\n'
  );
  assert.equal(await readJsonlResponse(body), "hello world");
});

test("stream finalAnswer emits only the suffix after streamed tokens", async () => {
  const chunks = await collect(
    streamJsonlToOpenAi(
      streamOf(
        '{"type":"stream","token":"hello "}\n',
        '{"type":"stream","token":"world"}\n',
        '{"type":"finalAnswer","text":"hello world!"}\n'
      ),
      "model",
      "id",
      1
    )
  );
  const wire = chunks.join("");
  assert.match(wire, /"content":"hello "/);
  assert.match(wire, /"content":"world"/);
  assert.match(wire, /"content":"!"/);
  assert.equal((wire.match(/"content":"hello world!"/g) || []).length, 0);
  assert.match(wire, /data: \[DONE\]/);
});

test("non-stream response over 16 MiB is cancelled and rejected", async () => {
  let cancelled = false;
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array(MAX_JSONL_RESPONSE_BYTES + 1));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(() => readJsonlResponse(body), HuggingChatStreamError);
  assert.equal(cancelled, true);
});

test("streaming response enforces the same byte ceiling", async () => {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array(MAX_JSONL_RESPONSE_BYTES + 1));
      }
    },
  });
  const gen = streamJsonlToOpenAi(body, "model", "id", 1);
  await assert.rejects(() => gen.next(), HuggingChatStreamError);
});

test("stalled JSONL read aborts instead of waiting forever", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController();
  const pending = readJsonlResponse(body, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(cancelled, true);
});
