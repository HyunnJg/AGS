import {
  systemText,
  type ContextLimits,
  type ContextPreview,
  type Message,
} from "../../../packages/contracts/src/context.ts";
import type { Preset } from "../../../packages/contracts/src/sessions.ts";

function cost(text: string) {
  return Buffer.byteLength(text, "utf8") + 8;
}

// UTF-8 bytes plus framing is a conservative estimate for an unknown model tokenizer.
export function assembleContext(
  preset: Preset,
  prompt: string,
  limits: ContextLimits,
  history: Message[],
  draft: string,
  modelWindow: number | null = null,
): ContextPreview {
  const system: Message = { role: "system", content: systemText(prompt, preset) };
  const request: Message = { role: "user", content: draft };
  let estimatedInput = cost(system.content) + cost(request.content);
  const windowInput = modelWindow === null ? Infinity : modelWindow - (limits.outputBudget ?? 0);
  const budget = Math.min(limits.inputBudget ?? Infinity, windowInput);
  let start = history.length;
  while (start >= 2 && (history.length - start) / 2 < limits.turns) {
    const previous = history[start - 2];
    const reply = history[start - 1];
    if (!previous || !reply) break;
    const pairCost = cost(previous.content) + cost(reply.content);
    if (estimatedInput + pairCost > budget) break;
    estimatedInput += pairCost;
    start -= 2;
  }
  return {
    messages: [system, ...history.slice(start), request],
    modelWindow,
    includedTurns: (history.length - start) / 2,
    estimatedInput,
    fits: estimatedInput <= budget,
    outputBudget: limits.outputBudget,
  };
}
