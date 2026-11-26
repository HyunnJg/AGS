import type { FileReference } from "../../../packages/contracts/src/workspace.ts";
import {
  systemText,
  defaultOrder,
  emptySources,
  blockNames,
  type Block,
  type BlockUsage,
  type SessionSources,
  type ContextLimits,
  type ContextPreview,
  type Message,
} from "../../../packages/contracts/src/context.ts";
import type { Preset } from "../../../packages/contracts/src/sessions.ts";

export function messageCost(text: string) {
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
  order: Block[] = defaultOrder,
  sources: SessionSources = emptySources,
  references: FileReference[] = [],
  sectionState = "",
  summaries: string[] = [],
): ContextPreview {
  const system: Message = { role: "system", content: systemText(prompt, preset) };
  const request: Message = { role: "user", content: draft };
  const systemCost = messageCost(system.content);
  const requestCost = messageCost(request.content);
  let estimatedInput = systemCost + requestCost;
  const blockUsage: BlockUsage[] = [
    { block: "system", estimatedTokens: systemCost, includedMessages: 1, omittedMessages: 0 },
  ];
  const windowInput = modelWindow === null ? Infinity : modelWindow - (limits.outputBudget ?? 0);
  const budget = Math.min(limits.inputBudget ?? Infinity, windowInput);
  const content: Record<Block, Message[]> = { memory: [], history: [], retrieval: [], input: [request] };
  const excluded: Block[] = [];
  // Keep the fixed instructions and current request. Admit optional blocks by layout order.
  for (const block of order) {
    const usage = { block, estimatedTokens: 0, includedMessages: 0, omittedMessages: 0 };
    blockUsage.push(usage);
    if (block === "input") {
      usage.estimatedTokens = requestCost;
      usage.includedMessages = 1;
      continue;
    }
    const previousTotal = estimatedInput;
    if (block === "history") {
      let start = history.length;
      const firstEligible = history.length - 2 * Math.min(limits.turns, Math.floor(history.length / 2));
      while (start > firstEligible) {
        const previous = history[start - 2],
          reply = history[start - 1];
        if (!previous || !reply) break;
        const size = messageCost(previous.content) + messageCost(reply.content);
        if (estimatedInput + size > budget) {
          usage.omittedMessages = start - firstEligible;
          break;
        }
        estimatedInput += size;
        start -= 2;
      }
      content.history = history.slice(start);
    } else {
      const excerpts = sources[block].trim()
        ? [
            `${blockNames[block]} (참고 자료)
${sources[block]}`,
          ]
        : [];
      if (block === "memory" && sectionState) excerpts.push(sectionState);
      if (block === "memory") excerpts.push(...summaries);
      if (block === "retrieval")
        for (const ref of references) {
          if (ref.paused) continue;
          const label = ref.kind === "knowledge" ? "지식 발췌" : "첨부 파일";
          excerpts.push(`${label} (참고 자료) · ${ref.project} / ${ref.path} · ${ref.start}–${ref.end}줄
${ref.text}`);
        }
      for (const text of excerpts) {
        const size = messageCost(text);
        if (estimatedInput + size <= budget) {
          content[block].push({ role: "user", content: text });
          estimatedInput += size;
        } else usage.omittedMessages++;
      }
    }
    usage.estimatedTokens = estimatedInput - previousTotal;
    usage.includedMessages = content[block].length;
    if (usage.omittedMessages) excluded.push(block);
  }
  const messages = [system, ...order.flatMap((block) => content[block])];
  const blocks: ContextPreview["blocks"] = [
    "system",
    ...order.flatMap((block) => content[block].map(() => block)),
  ];
  return {
    messages,
    blocks,
    excluded,
    modelWindow,
    inputCeiling: Number.isFinite(budget) ? Math.max(0, budget) : null,
    blockUsage,
    includedTurns: content.history.length / 2,
    estimatedInput,
    fits: estimatedInput <= budget,
    outputBudget: limits.outputBudget,
  };
}
