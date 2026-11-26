import { randomUUID } from "node:crypto";
import type { CallKind, CallLog, CallStatus } from "../../contracts/src/calls.ts";
import type { Message } from "../../contracts/src/context.ts";
import type { ModelSelection } from "../../contracts/src/providers.ts";

const limit = 65536;
const hidden = "[가림]";
const visibleHeaders =
  /^(content-type|content-length|content-encoding|cache-control|date|server|retry-after|request-id|x-request-id|cf-ray|x-ratelimit-[a-z-]+|openai-processing-ms)$/i;

export class CallCapture {
  private readonly started = Date.now();
  private readonly secrets = new Set<string>();
  private readonly meta: Pick<CallLog, "kind" | "session" | "model" | "provider">;
  private readonly save: (log: CallLog) => void;
  private readonly raw = Buffer.alloc(limit);
  private size = 0;
  private clipped = false;
  private text = "";
  private textClipped = false;
  private request?: CallLog["request"];
  private http: number | null = null;
  private headers: Record<string, string> = {};
  private done = false;
  constructor(
    kind: CallKind,
    selection: ModelSelection,
    session: string | null,
    save: (log: CallLog) => void,
  ) {
    this.meta = { kind, provider: selection.provider, model: selection.model, session };
    this.save = save;
  }
  protect(...values: (string | undefined)[]) {
    for (const value of values) if (value) this.secrets.add(value);
  }
  recordRequest(messages: Message[], maxTokens?: number | null) {
    this.request = {
      messageCount: messages.length,
      contentBytes: messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, "utf8"), 0),
      maxTokens: maxTokens ?? null,
    };
  }
  response(response: Response) {
    this.http = response.status;
    this.headers = Object.fromEntries(
      [...response.headers]
        .slice(0, 100)
        .map(([name, value]) => [
          name,
          visibleHeaders.test(name) ? this.clean(value).slice(0, 1024) : hidden,
        ]),
    );
  }
  bytes(chunk: Uint8Array) {
    const count = Math.min(chunk.length, limit - this.size);
    if (count < chunk.length) this.clipped = true;
    this.raw.set(chunk.subarray(0, count), this.size);
    this.size += count;
  }
  answer(part: string) {
    const remaining = limit - this.text.length;
    this.text += part.slice(0, remaining);
    if (part.length > remaining) this.textClipped = true;
  }
  private clean(source: string, limited = false) {
    let text = source;
    for (const secret of this.secrets) {
      if (limited) {
        // A retained prefix may end inside a credential.
        for (let n = Math.min(secret.length - 1, text.length); n > 0; n--)
          if (text.endsWith(secret.slice(0, n))) {
            text = text.slice(0, -n) + hidden;
            break;
          }
      }
      text = text.replaceAll(secret, hidden);
    }
    return text
      .replace(/(Bearer\s+)[^\s"',}]+/gi, `$1${hidden}`)
      .replace(
        /("(?:x-api-key|x-goog-api-key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|authorization|proxy-authorization|password|secret|set-cookie|cookie)"\s*:\s*")(?:\\.|[^"\\\r\n])*/gi,
        `$1${hidden}`,
      );
  }
  finish(status: CallStatus) {
    if (this.done) return;
    this.done = true;
    try {
      const raw = this.raw.toString("utf8", 0, this.size);
      // Keys can be split across SSE frames even when the assembled answer contains them verbatim.
      const sensitiveAnswer = [...this.secrets].some((s) => this.text.includes(s));
      this.save({
        ...this.meta,
        model: this.clean(this.meta.model),
        id: randomUUID(),
        started: this.started,
        durationMs: Date.now() - this.started,
        status,
        httpStatus: this.http,
        ...(this.request && { request: this.request }),
        headers: this.headers,
        body: sensitiveAnswer && raw ? hidden : this.clean(raw, this.clipped),
        bodyLimited: this.clipped,
        answer: this.clean(this.text, this.textClipped),
        answerLimited: this.textClipped,
      });
    } catch {
      /* A diagnostic write must not change the provider result. */
    }
  }
  // Providers may return a JSON/text error instead of SSE. Bound diagnostic reads by size and time.
  async errorBody(body: ReadableStream<Uint8Array> | null) {
    if (!body) return;
    const reader = body.getReader();
    const timer = setTimeout(() => {
      this.clipped = true;
      void reader.cancel().catch(() => {});
    }, 750);
    try {
      while (this.size < limit) {
        const { value, done } = await reader.read();
        if (done) return;
        this.bytes(value);
      }
      this.clipped = true;
    } catch {
      this.clipped = true;
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export function callStatus(signal: AbortSignal): CallStatus {
  if (!signal.aborted) return "failed";
  return signal.reason === "timeout" || signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled";
}
