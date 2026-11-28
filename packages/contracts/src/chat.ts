import { folderShareFlags, type FolderProvider } from "./providers.ts";
export interface ChatRequest {
  message: string;
  workspaceScope?: string;
  workspaceShare?: (typeof folderShareFlags)[FolderProvider];
}

export function isChatRequest(value: unknown): value is ChatRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (!("workspaceShare" in value) || (Object.values(folderShareFlags).some(flag => flag === value.workspaceShare) && "workspaceScope" in value)) &&
    (!("workspaceScope" in value) || (typeof value.workspaceScope === "string" && /^[a-f0-9]{64}$/.test(value.workspaceScope))) &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.trim().length > 0
  );
}

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; code: "workspace_tool_budget" | "workspace_read_failed" | "provider_failed" | "provider_auth" | "provider_output_budget" | "provider_limit" | "storage_failed" | "timeout" }
  | { type: "cancelled" };

export function encodeEvent(event: ChatEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
