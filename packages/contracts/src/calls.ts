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
}
export interface CallLog extends CallSummary {
  headers: Record<string, string>;
  body: string;
  bodyLimited: boolean;
  answer: string;
  answerLimited: boolean;
}
