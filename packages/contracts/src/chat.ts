export interface ChatRequest {
  message: string;
}

export function isChatRequest(value: unknown): value is ChatRequest {
  return typeof value === "object" && value !== null && "message" in value
    && typeof value.message === "string" && value.message.trim().length > 0;
}

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; code: "provider_failed" | "timeout" }
  | { type: "cancelled" };

export function encodeEvent(event: ChatEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
