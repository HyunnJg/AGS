import type { FileReference } from "../../../packages/contracts/src/workspace.ts";
import {
  systemText,
  defaultOrder,
  emptySources,
  blockNames,
  type Block,
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
  let estimatedInput = messageCost(system.content) + messageCost(request.content);
  const windowInput = modelWindow === null ? Infinity : modelWindow - (limits.outputBudget ?? 0);
  const budget = Math.min(limits.inputBudget ?? Infinity, windowInput);
  const content: Record<Block, Message[]> = { memory: [], history: [], retrieval: [], input: [request] };
  const excluded: Block[] = [];
  // Keep the fixed instructions and current request. Admit optional blocks by layout order.
  for (const block of order) {
    if (block === "input") continue;
    if (block === "history") {
      let start = history.length;
      while (start >= 2 && (history.length - start) / 2 < limits.turns) {
        const previous = history[start - 2],
          reply = history[start - 1];
        if (!previous || !reply) break;
        const size = messageCost(previous.content) + messageCost(reply.content);
        if (estimatedInput + size > budget) {
          excluded.push(block);
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
        for (const ref of references)
          excerpts.push(`첨부 파일 (참고 자료) · ${ref.project} / ${ref.path} · ${ref.start}–${ref.end}줄
${ref.text}`);
      for (const text of excerpts) {
        const size = messageCost(text);
        if (estimatedInput + size <= budget) {
          content[block].push({ role: "user", content: text });
          estimatedInput += size;
        } else if (!excluded.includes(block)) excluded.push(block);
      }
    }
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
    includedTurns: content.history.length / 2,
    estimatedInput,
    fits: estimatedInput <= budget,
    outputBudget: limits.outputBudget,
  };
}
