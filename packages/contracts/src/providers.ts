export const providerNames = {
  mock: "로컬 mock",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  custom: "사용자 지정 API",
} as const;
export type ProviderId = keyof typeof providerNames;
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
  return (
    isConnectionId(value.provider) &&
    typeof value.model === "string" &&
    /^[!-~]{1,256}$/.test(value.model)
  );
}

export interface CatalogModel {
  id: string;
  name: string;
  contextLength?: number;
}

export type ConnectionId = Exclude<ProviderId, "mock">;
export function isConnectionId(id: unknown): id is ConnectionId {
  return id === "openai" || id === "openrouter" || id === "custom";
}
export interface ConnectionView {
  revision: number;
  baseUrl: string;
  defaultModel: string;
  hasKey: boolean;
  needsKey: boolean;
  persistentKeys: boolean;
}
