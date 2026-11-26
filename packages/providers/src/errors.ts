import type { ProviderId } from "../../contracts/src/providers.ts";
import { type CallCapture, readErrorBody } from "./capture.ts";
import { invalidGeminiKey } from "./gemini.ts";

type UpstreamCode = "provider_auth" | "provider_limit" | "provider_failed";
export class ProviderError extends Error {
  readonly code: UpstreamCode;
  constructor(code: UpstreamCode) {
    super(code);
    this.code = code;
  }
}

export async function responseError(provider: ProviderId, response: Response, capture?: CallCapture) {
  const googleBadRequest = provider === "gemini" && response.status === 400;
  const body = capture || googleBadRequest ? await readErrorBody(response.body, capture) : "";
  if (!capture && !googleBadRequest) await response.body?.cancel();
  if ([401, 403].includes(response.status) || (googleBadRequest && invalidGeminiKey(body)))
    return new ProviderError("provider_auth");
  return new ProviderError(response.status === 429 ? "provider_limit" : "provider_failed");
}
