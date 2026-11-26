import type { Message } from "../../contracts/src/context.ts";

export const anthropicVersion = "2026-10-21";
export const defaultClaudeOutput = 4096;

export function anthropicPayload(model: string, input: Message[], maxTokens: number) {
  const system = [];
  const messages = [];
  for (const { role, content } of input) {
    if (role === "system") system.push({ type: "text", text: content });
    else messages.push({ role, content });
  }
  return { model, system, messages, max_tokens: maxTokens, stream: true };
}

export async function* anthropicReply(events: AsyncIterable<string>) {
  let started = false;
  let hasText = false;
  let reason: string | undefined;
  for await (const data of events) {
    const event = JSON.parse(data);
    if (event.type === "error") throw new Error("anthropic_stream_error");
    if (event.type === "message_start") {
      if (started) throw new Error("duplicate_message_start");
      started = true;
    }
    if (event.type === "message_delta" && event.delta?.stop_reason) reason = event.delta.stop_reason;
    if (event.type === "message_stop") {
      if (
        started &&
        hasText &&
        ["end_turn", "max_tokens", "stop_sequence", "refusal", "model_context_window_exceeded"].includes(
          reason ?? "",
        )
      )
        return;
      throw new Error("incomplete_anthropic_message");
    }
    const block = event.content_block;
    const delta = event.delta;
    const text =
      event.type === "content_block_start" && block?.type === "text"
        ? block.text
        : event.type === "content_block_delta" && delta?.type === "text_delta"
          ? delta.text
          : undefined;
    if (typeof text === "string" && text) {
      if (!started) throw new Error("missing_message_start");
      hasText = true;
      yield text;
    }
  }
  throw new Error("incomplete_anthropic_message");
}
