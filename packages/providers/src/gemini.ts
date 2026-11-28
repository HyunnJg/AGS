import type { CallCapture } from "./capture.ts";
import { ProviderError } from "./errors.ts";
import type { Decision } from "./folder-tools.ts";
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

function recordGeminiUsage(capture: CallCapture | undefined, usage?: Record<string, unknown>) {
  if (!usage || !capture) return;
  capture.recordTokens("inputTokens", usage.promptTokenCount);
  capture.recordTokens("candidateTokens", usage.candidatesTokenCount);
  capture.recordTokens("reasoningTokens", usage.thoughtsTokenCount);
  capture.recordTokens("cachedInputTokens", usage.cachedContentTokenCount);
  capture.recordTokens("toolPromptTokens", usage.toolUsePromptTokenCount);
  capture.recordTokens("totalTokens", usage.totalTokenCount);
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function geminiDecision(body: ReturnType<typeof JSON.parse>, capture?: CallCapture): Decision {
  const usage = body.usageMetadata;
  recordGeminiUsage(capture, usage);
  const candidate = body.candidates?.[0];
  const parts = candidate?.content?.parts;
  const blocked = body.promptFeedback?.blockReason;
  if (body.error || (blocked && blocked !== "BLOCK_REASON_UNSPECIFIED") || body.candidates?.length !== 1 ||
      candidate?.content?.role !== "model" || !Array.isArray(parts) || !["STOP", "MAX_TOKENS"].includes(candidate.finishReason))
    throw new Error("invalid_gemini_folder_response");

  let call: { id?: string; name: string } | undefined;
  const visible: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object" || Array.isArray(part) ||
        Object.keys(part).some(k => !["text", "functionCall", "thought", "thoughtSignature"].includes(k)) ||
        ("thought" in part && typeof part.thought !== "boolean") ||
        ("thoughtSignature" in part && typeof part.thoughtSignature !== "string"))
      throw new Error("invalid_gemini_folder_response");
    if (typeof part.text === "string" && !("functionCall" in part)) {
      if (!part.thought) visible.push(part.text);
      continue;
    }
    const fn = part.functionCall;
    if (call || "text" in part || !fn || fn.name !== "list_entries" || candidate.finishReason !== "STOP" ||
        Object.keys(fn).some(k => !["id", "name", "args"].includes(k)) ||
        ("id" in fn && (typeof fn.id !== "string" || !fn.id.trim())) ||
        ("args" in fn && (!fn.args || typeof fn.args !== "object" || Array.isArray(fn.args) || Object.keys(fn.args).length)))
      throw new Error("invalid_gemini_folder_response");
    call = fn;
  }
  if (!call) {
    const answer = visible.join("");
    if (!answer) throw new Error("invalid_gemini_folder_response");
    return { answer };
  }
  const id = call.id;
  const candidates = usage?.candidatesTokenCount;
  const thoughts = usage?.thoughtsTokenCount === undefined ? 0 : usage.thoughtsTokenCount;
  const used = validCount(candidates) && validCount(thoughts) ? candidates + thoughts : null;
  return { used: validCount(used) ? used : null, followup: result => ({
    provider: "gemini", contents: [
      { role: "model", parts },
      { role: "user", parts: [{ functionResponse: { name: "list_entries", ...(id && { id }), response: JSON.parse(result) } }] },
    ],
  }) };
}

export async function* geminiReply(events: AsyncIterable<string>, capture?: CallCapture, finalFolderRound = false) {
  let finishReason: string | undefined;
  let hasText = false;
  for await (const data of events) {
    const chunk = JSON.parse(data);
    recordGeminiUsage(capture, chunk.usageMetadata);
    const blocked = chunk.promptFeedback?.blockReason;
    if (chunk.error || (blocked && blocked !== "BLOCK_REASON_UNSPECIFIED"))
      throw new Error("gemini_blocked_or_failed");
    if (finalFolderRound && (chunk.candidates?.length > 1 ||
        chunk.candidates?.[0]?.content?.parts?.some((part: Record<string, unknown>) => "functionCall" in part)))
      throw new Error("invalid_gemini_folder_response");
    const candidate = chunk.candidates?.[0];
    if (!candidate) continue; // Usage-only frame.
    if (finishReason) throw new Error("unexpected_candidate");
    const reason = candidate.finishReason;
    const terminal = reason && reason !== "FINISH_REASON_UNSPECIFIED";
    if (terminal && !["STOP", "MAX_TOKENS"].includes(reason)) throw new Error("gemini_finish_failed");
    for (const part of candidate.content?.parts ?? []) {
      if (!part.thought && typeof part.text === "string" && part.text) {
        if (part.text.trim()) hasText = true;
        yield part.text;
      }
    }
    if (terminal) finishReason = reason;
  }
  if (!hasText && finishReason === "MAX_TOKENS") throw new ProviderError("provider_output_budget");
  if (!finishReason || !hasText) throw new Error("incomplete_gemini_reply");
}
