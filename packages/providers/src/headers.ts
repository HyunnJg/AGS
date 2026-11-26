import type { ProviderId } from "../../contracts/src/providers.ts";
import { anthropicVersion } from "./anthropic.ts";

export function providerHeaders(provider: ProviderId, key?: string): Record<string, string> {
  if (!key) return {};
  if (provider === "gemini") return { "x-goog-api-key": key };
  if (provider === "anthropic")
    return { authorization: `Bearer ${key}`, "anthropic-version": anthropicVersion };
  return { authorization: `Bearer ${key}` };
}
