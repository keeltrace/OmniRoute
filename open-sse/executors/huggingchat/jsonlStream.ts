// Pure JSONL stream translation (HuggingChat NDJSON -> OpenAI SSE). Verbatim from huggingchat.ts.

export class HuggingChatStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HuggingChatStreamError";
  }
}

export const MAX_JSONL_RESPONSE_BYTES = 16 * 1024 * 1024;

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("HuggingChat response read aborted");
  error.name = "AbortError";
  return error;
}

async function readReaderChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal | null
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) {
    cancelReader(reader);
    throw abortError(signal);
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      cancelReader(reader);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([reader.read(), aborted]);
    // reader.cancel() may resolve the pending read as { done: true } before
    // the abort promise rejection is observed. Preserve abort semantics rather
    // than turning a cancelled/stalled upstream into an empty success.
    if (signal.aborted) throw abortError(signal);
    return result;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function addResponseBytes(total: number, value: Uint8Array | undefined): number {
  const next = total + (value?.byteLength || 0);
  if (next > MAX_JSONL_RESPONSE_BYTES) {
    throw new HuggingChatStreamError(
      `HuggingChat upstream response exceeded ${MAX_JSONL_RESPONSE_BYTES} byte limit`
    );
  }
  return next;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // The error event is authoritative; transport cleanup is best effort.
  }
}

function bindReaderCancellation(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal | null
): () => void {
  if (!signal) return () => undefined;

  const cancel = () => cancelReader(reader);
  if (signal.aborted) {
    cancel();
    return () => undefined;
  }

  signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}

export function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function parseJsonlLine(line: string): {
  token?: string;
  done?: boolean;
  error?: string;
  text?: string;
} {
  try {
    const event = JSON.parse(line);

    if (event.type === "stream" && typeof event.token === "string") {
      const token = event.token.replace(/\0/g, "");
      if (token) return { token };
    }

    if (event.type === "finalAnswer" && typeof event.text === "string") {
      return { text: event.text, done: true };
    }

    if (event.type === "status") {
      if (event.status === "error") {
        return { error: event.message || "HuggingChat generation error" };
      }
      if (event.status === "finished") {
        return { done: true };
      }
    }
  } catch {
    // Skip non-JSON lines
  }

  return {};
}

export async function* streamJsonlToOpenAi(
  body: ReadableStream<Uint8Array>,
  model: string,
  id: string,
  created: number,
  signal?: AbortSignal | null,
  cancellationSignal?: AbortSignal | null
): AsyncGenerator<string> {
  const reader = body.getReader();
  const unbindReaderCancellation = bindReaderCancellation(reader, cancellationSignal);
  const decoder = new TextDecoder();
  let buffer = "";
  let emittedRole = false;
  let emittedTextLength = 0;
  let responseBytes = 0;
  let finished = false;

  try {
    while (true) {
      if (signal?.aborted) break;

      const { value, done } = await readReaderChunk(reader, signal);
      if (done) break;

      try {
        responseBytes = addResponseBytes(responseBytes, value);
      } catch (error) {
        cancelReader(reader);
        throw error;
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parsed = parseJsonlLine(trimmed);

        if (parsed.error) {
          cancelReader(reader);
          throw new HuggingChatStreamError(parsed.error);
        }

        if (parsed.token) {
          if (!emittedRole) {
            emittedRole = true;
            yield sseChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            });
          }

          emittedTextLength += parsed.token.length;
          yield sseChunk({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: parsed.token }, finish_reason: null }],
          });
        }

        if (parsed.text) {
          const remaining = parsed.text.slice(emittedTextLength);
          if (remaining) {
            if (!emittedRole) {
              emittedRole = true;
              yield sseChunk({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              });
            }
            yield sseChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: remaining }, finish_reason: null }],
            });
          }
          finished = true;
          break;
        }

        if (parsed.done) {
          finished = true;
          break;
        }
      }

      if (finished) break;
    }

    if (!finished && buffer.trim()) {
      const parsed = parseJsonlLine(buffer.trim());
      if (parsed.error) {
        throw new HuggingChatStreamError(parsed.error);
      }
      if (parsed.token && !signal?.aborted) {
        if (!emittedRole) {
          emittedRole = true;
          yield sseChunk({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          });
        }
        yield sseChunk({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: parsed.token }, finish_reason: null }],
        });
      }
    }
  } finally {
    unbindReaderCancellation();
    reader.releaseLock();
  }

  if (!signal?.aborted && !cancellationSignal?.aborted) {
    yield sseChunk({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    if (!signal?.aborted && !cancellationSignal?.aborted) {
      yield "data: [DONE]\n\n";
    }
  }
}

export async function readJsonlResponse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal | null
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const textFragments: string[] = [];
  let responseBytes = 0;

  try {
    while (true) {
      if (signal?.aborted) break;

      const { value, done } = await readReaderChunk(reader, signal);
      if (done) break;

      try {
        responseBytes = addResponseBytes(responseBytes, value);
      } catch (error) {
        cancelReader(reader);
        throw error;
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parsed = parseJsonlLine(trimmed);
        if (parsed.token) textFragments.push(parsed.token);
        if (parsed.text) return parsed.text;
        if (parsed.error) {
          cancelReader(reader);
          throw new HuggingChatStreamError(parsed.error);
        }
      }
    }

    if (buffer.trim()) {
      const parsed = parseJsonlLine(buffer.trim());
      if (parsed.text) return parsed.text;
      if (parsed.token) textFragments.push(parsed.token);
      if (parsed.error) throw new HuggingChatStreamError(parsed.error);
    }
  } finally {
    reader.releaseLock();
  }

  return textFragments.join("");
}
