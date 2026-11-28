export const providerNames = {
  mock: "로컬 mock",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic (Claude)",
  gemini: "Google Gemini",
  custom: "사용자 지정 API",
} as const;
export type ProviderId = keyof typeof providerNames;
export const workspaceToolModes: Partial<Record<ProviderId, "local" | "share_root_list">> = {
  mock: "local",
  openai: "share_root_list",
  anthropic: "share_root_list",
};
export type FolderProvider = "openai" | "anthropic";
export function isFolderProvider(id: ProviderId | undefined): id is FolderProvider {
  return id === "openai" || id === "anthropic";
}
export const folderShareFlags = { openai: "openai_root_names", anthropic: "anthropic_root_names" } as const;
export interface ModelSelection {
  provider: ProviderId;
  model: string;
}
export interface ProviderOption {
  id: ProviderId;
  enabled: boolean;
  defaultModel: string;
}
export function isModelSelection(value: unknown): value is ModelSelection {
  if (!value || typeof value !== "object" || !("provider" in value) || !("model" in value)) return false;
  if (value.provider === "mock") return value.model === "";
  if (value.provider === "gemini")
    return typeof value.model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value.model);
  return (
    isConnectionId(value.provider) && typeof value.model === "string" && /^[!-~]{1,256}$/.test(value.model)
  );
}

export interface CatalogModel {
  id: string;
  name: string;
  contextLength?: number;
}

export type ConnectionId = Exclude<ProviderId, "mock">;
export function isConnectionId(id: unknown): id is ConnectionId {
  return id === "anthropic" || id === "gemini" || id === "openai" || id === "openrouter" || id === "custom";
}
export interface ConnectionView {
  revision: number;
  baseUrl: string;
  defaultModel: string;
  hasKey: boolean;
  needsKey: boolean;
  persistentKeys: boolean;
}
