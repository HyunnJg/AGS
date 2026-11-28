import type { FileReference } from "./workspace.ts";
import type { Turn } from "./sessions.ts";

export const reviewInputLimit = 8000;
export const reviewOutputTokens = 4096;
export interface Review extends Pick<Turn, "id" | "provider" | "model" | "message" | "reply" | "status"> {
  reviewer: string;
}

export interface ReviewHistoryItem extends Pick<Review, "id" | "reviewer" | "model" | "provider" | "status"> {
  title: string;
}

export function reviewMessage(objective: string, refs: FileReference[]) {
  return [
    objective.trim(),
    ...refs.map(
      (ref) =>
        `[${ref.kind === "knowledge" ? "지식 발췌" : "파일 발췌"} · ${ref.project} / ${ref.path} · ${ref.start}–${ref.end}줄 · 버전 ${ref.version}]\n${ref.text}`,
    ),
  ].join("\n\n");
}
