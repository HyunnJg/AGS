import type { CallCapture } from "./capture.ts";
import { createCatalog } from "./catalog.ts";
import type { ModelSelection, ProviderId, ProviderOption } from "../../contracts/src/providers.ts";
import type { Message } from "../../contracts/src/context.ts";

export const openRouterBaseUrl = "https://openrouter.ai/api/v1/";

export function customEndpoint(base: string | undefined) {
  if (!base?.trim()) return undefined;
  const url = new URL(base);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && local))
  )
    throw new Error("invalid_custom_url");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.href;
}

type UpstreamCode = "provider_auth" | "provider_limit" | "provider_failed";
export class ProviderError extends Error {
  readonly code: UpstreamCode;
  constructor(code: UpstreamCode) {
    super(code);
    this.code = code;
  }
}

// Decode frames across arbitrary network and UTF-8 boundaries, including SSE comments.
async function* readReply(body: ReadableStream<Uint8Array>, onActivity?: () => void, capture?: CallCapture) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new ProviderError("provider_failed");
      capture?.bytes(value);
      onActivity?.();
      pending += decoder.decode(value, { stream: true });
      for (;;) {
        const delimiter = /\r?\n\r?\n/.exec(pending);
        if (!delimiter) break;
        const frame = pending.slice(0, delimiter.index);
        pending = pending.slice(delimiter.index + delimiter[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        if (data.trim() === "[DONE]") return;
        const chunk = JSON.parse(data);
        const choice = chunk.choices?.[0];
        if (chunk.error || choice?.finish_reason === "error") throw new ProviderError("provider_failed");
        const content = choice?.delta?.content;
        if (typeof content === "string" && content) yield content;
      }
      if (pending.length > 2 * 1024 * 1024) throw new ProviderError("provider_failed");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function configureProviders(env: NodeJS.ProcessEnv, send: typeof fetch = fetch) {
  const custom = customEndpoint(env.AGS_CUSTOM_BASE_URL);
  const options: ProviderOption[] = [
    { id: "mock", enabled: true, defaultModel: "" },
    {
      id: "openrouter",
      enabled: Boolean(env.AGS_OPENROUTER_API_KEY),
      defaultModel: env.AGS_OPENROUTER_MODEL?.trim() || "",
    },
    { id: "custom", enabled: Boolean(custom), defaultModel: env.AGS_CUSTOM_MODEL?.trim() || "" },
  ];
  function endpoint(provider: ProviderId) {
    const router = provider === "openrouter";
    const url = router ? openRouterBaseUrl : custom;
    const key = router ? env.AGS_OPENROUTER_API_KEY : env.AGS_CUSTOM_API_KEY;
    return { url, key };
  }
  async function* stream(
    selection: ModelSelection,
    messages: Message[],
    signal: AbortSignal,
    onActivity?: () => void,
    outputBudget?: number | null,
    capture?: CallCapture,
  ) {
    const { url, key } = endpoint(selection.provider);
    protect(capture);
    if (!url || (selection.provider === "openrouter" && !key) || selection.provider === "mock")
      throw new ProviderError("provider_failed");
    try {
      const response = await send(new URL("chat/completions", url).href, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(key && { authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify({
          model: selection.model,
          stream: true,
          messages,
          ...(outputBudget != null && { max_tokens: outputBudget }),
        }),
      });
      capture?.response(response);
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")
      ) {
        if (capture) await capture.errorBody(response.body);
        else await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new ProviderError("provider_auth");
        throw new ProviderError(response.status === 429 ? "provider_limit" : "provider_failed");
      }
      yield* readReply(response.body, onActivity, capture);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("provider_failed");
    }
  }
  function protect(capture?: CallCapture) {
    capture?.protect(env.AGS_CUSTOM_API_KEY, env.AGS_OPENROUTER_API_KEY);
  }
  return { options, stream, protect, ...createCatalog(send, endpoint) };
}
