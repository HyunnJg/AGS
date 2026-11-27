import type { ContextBudget } from "./context.ts";
import type { ModelSelection } from "./providers.ts";

export const callKinds = {
  chat: "채팅",
  review: "독립 검토",
  checkpoint: "구간 요약",
  catalog: "모델 목록",
} as const;
export type CallKind = keyof typeof callKinds;
export type CallStatus = "completed" | "failed" | "cancelled" | "timeout";
export interface CallSummary extends ModelSelection {
  id: string;
  session: string | null;
  kind: CallKind;
  started: number;
  durationMs: number;
  status: CallStatus;
  httpStatus: number | null;
  usage?: ReportedUsage;
}
export const usageLabels = {
  inputTokens: "입력",
  uncachedInputTokens: "입력 (캐시 제외)",
  cachedInputTokens: "캐시 읽기",
  cacheWriteTokens: "캐시 쓰기",
  outputTokens: "출력",
  candidateTokens: "후보 출력",
  reasoningTokens: "추론",
  toolPromptTokens: "도구 입력",
  totalTokens: "합계",
} as const;
export type ReportedUsage = Partial<Record<keyof typeof usageLabels, number>>;

export interface CallLog extends CallSummary {
  contextBudget?: ContextBudget;
  request?: { messageCount: number; contentBytes: number; maxTokens: number | null };
  headers: Record<string, string>;
  body: string;
  bodyLimited: boolean;
  answer: string;
  answerLimited: boolean;
}
