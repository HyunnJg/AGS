import type { CallCapture } from "./capture.ts";
import type { Message } from "../../contracts/src/context.ts";

export function geminiPayload(messages: Message[], outputBudget?: number | null) {
  const system = [];
  const contents: { role: "user" | "model"; parts: { text: string }[] }[] = [];
  for (const message of messages) {
    const part = { text: message.content };
    if (message.role === "system") {
      system.push(part);
      continue;
    }
    const role = message.role === "assistant" ? "model" : "user";
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(part);
    else contents.push({ role, parts: [part] });
  }
  return {
    ...(system.length && { systemInstruction: { parts: system } }),
    contents,
    ...(outputBudget != null && { generationConfig: { maxOutputTokens: outputBudget } }),
  };
}

export async function* geminiReply(events: AsyncIterable<string>, capture?: CallCapture) {
  let finished = false;
  let hasText = false;
  for await (const data of events) {
    const chunk = JSON.parse(data);
    const usage = chunk.usageMetadata;
    if (usage && capture) {
      capture.recordTokens("inputTokens", usage.promptTokenCount);
      capture.recordTokens("candidateTokens", usage.candidatesTokenCount);
      capture.recordTokens("reasoningTokens", usage.thoughtsTokenCount);
      capture.recordTokens("cachedInputTokens", usage.cachedContentTokenCount);
      capture.recordTokens("toolPromptTokens", usage.toolUsePromptTokenCount);
      capture.recordTokens("totalTokens", usage.totalTokenCount);
    }
    const blocked = chunk.promptFeedback?.blockReason;
    if (chunk.error || (blocked && blocked !== "BLOCK_REASON_UNSPECIFIED"))
      throw new Error("gemini_blocked_or_failed");
    const candidate = chunk.candidates?.[0];
    if (!candidate) continue; // Usage-only frame.
    if (finished) throw new Error("unexpected_candidate");
    const reason = candidate.finishReason;
    const terminal = reason && reason !== "FINISH_REASON_UNSPECIFIED";
    if (terminal && !["STOP", "MAX_TOKENS"].includes(reason)) throw new Error("gemini_finish_failed");
    for (const part of candidate.content?.parts ?? []) {
      if (!part.thought && typeof part.text === "string" && part.text) {
        hasText = true;
        yield part.text;
      }
    }
    if (terminal) finished = true;
  }
  if (!finished || !hasText) throw new Error("incomplete_gemini_reply");
}

export function invalidGeminiKey(body: string) {
  try {
    const details = JSON.parse(body).error?.details;
    return Array.isArray(details) && details.some((item) => item?.reason === "API_KEY_INVALID");
  } catch {
    return false;
  }
}
