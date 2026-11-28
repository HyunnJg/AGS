import type { CallCapture } from "./capture.ts";
import type { Decision } from "./folder-tools.ts";
import { ProviderError } from "./errors.ts";

export const minimumResponsesOutput = 16;

export function responsesPayload(model: string, input: object[], maxTokens?: number | null) {
  return { model, input, store: false, ...(maxTokens != null && { max_output_tokens: maxTokens }) };
}

function recordUsage(capture: CallCapture | undefined, usage?: {
  input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown }; output_tokens_details?: { reasoning_tokens?: unknown };
}) {
  if (!capture || !usage) return;
  capture.recordTokens("inputTokens", usage.input_tokens);
  capture.recordTokens("outputTokens", usage.output_tokens);
  capture.recordTokens("totalTokens", usage.total_tokens);
  capture.recordTokens("cachedInputTokens", usage.input_tokens_details?.cached_tokens);
  capture.recordTokens("reasoningTokens", usage.output_tokens_details?.reasoning_tokens);
}

function inspectOutput(body: ReturnType<typeof JSON.parse>, allowCall: boolean) {
  const completed = body.status === "completed";
  const partial = body.status === "incomplete" && ["max_output_tokens", "content_filter"].includes(body.incomplete_details?.reason);
  if (body.error || !(completed || partial) || !Array.isArray(body.output)) throw new ProviderError("provider_failed");
  let callId: string | undefined;
  let replayable = true;
  const text: string[] = [];
  for (const item of body.output) {
    if (item?.type === "reasoning") {
      if (typeof item.encrypted_content !== "string" || !item.encrypted_content) replayable = false;
    } else if (item?.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "output_text" && typeof part.text === "string") text.push(part.text);
        else if (part.type === "refusal" && typeof part.refusal === "string") text.push(part.refusal);
        else throw new ProviderError("provider_failed");
      }
    } else if (allowCall && completed && item?.type === "function_call" && !callId && item.name === "list_entries" &&
        (item.status === undefined || item.status === "completed") &&
        typeof item.call_id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(item.call_id) &&
        typeof item.arguments === "string" && /^\s*\{\s*\}\s*$/.test(item.arguments)) {
      callId = item.call_id;
    } else throw new ProviderError("provider_failed");
  }
  const answer = text.join("");
  if (callId ? !replayable : !answer) throw new ProviderError("provider_failed");
  return { answer, callId };
}

export function openAiDecision(body: ReturnType<typeof JSON.parse>, capture?: CallCapture): Decision {
  recordUsage(capture, body.usage);
  const { answer, callId } = inspectOutput(body, true);
  if (!callId) return { answer };
  const used = body.usage?.output_tokens;
  return { used: Number.isSafeInteger(used) && used >= 0 ? used : null, followup: result => ({
    provider: "openai",
    items: [...body.output, { type: "function_call_output", call_id: callId, output: result }],
  }) };
}

export async function* responsesReply(events: AsyncIterable<string>, capture?: CallCapture) {
  let visibleLength = 0;
  for await (const data of events) {
    const event = JSON.parse(data);
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      recordUsage(capture, event.response?.usage);
      if (event.type !== `response.${event.response?.status}`) throw new ProviderError("provider_failed");
      const { answer } = inspectOutput(event.response, false);
      if (!visibleLength) yield answer;
      else if (visibleLength !== answer.length) throw new ProviderError("provider_failed");
      return;
    }
    if (event.type === "response.failed" || event.type === "error" ||
        event.type.startsWith("response.function_call_arguments.") ||
        (event.item && !["message", "reasoning"].includes(event.item.type)))
      throw new ProviderError("provider_failed");
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      if (typeof event.delta !== "string") throw new ProviderError("provider_failed");
      if (event.delta) {
        visibleLength += event.delta.length;
        yield event.delta;
      }
    }
  }
  throw new ProviderError("provider_failed");
}
