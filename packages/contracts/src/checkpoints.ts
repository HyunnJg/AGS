export interface CheckpointRange {
  binding: string;
  first: string;
  last: string;
  count: number;
  path: string;
}
export interface CheckpointDraft extends CheckpointRange {
  sources: { id: string; question: string; reply: string }[];
  summary: string;
}
export const maxSummary = 2400;
export const maxCheckpointTurns = 8;
