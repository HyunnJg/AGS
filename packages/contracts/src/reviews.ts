import type { Turn } from "./sessions.ts";

export const reviewInputLimit = 8000;
export const reviewOutputTokens = 1200;
export interface Review extends Pick<Turn, "id" | "provider" | "model" | "message" | "reply" | "status"> {
  reviewer: string;
}
