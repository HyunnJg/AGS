import type { ModelSelection, ProviderOption } from "../../contracts/src/providers.ts";
import type { Preset } from "../../contracts/src/sessions.ts";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

const instructions: Record<Preset, string> = {
  general: "사용자의 요청에 맞추어 답하세요.",
  coding: "코드의 정확성과 재현 가능한 검증을 우선하세요.",
  research: "근거와 추론을 구분하고 출처의 한계를 명시하세요.",
  writing: "사용자가 지정한 독자와 목적, 문체를 고려해 작성하세요.",
};

function customEndpoint(base: string | undefined) {
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
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
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
async function* readReply(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new ProviderError("provider_failed");
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
  async function* stream(
    selection: ModelSelection,
    preset: Preset,
    messages: Message[],
    signal: AbortSignal,
  ) {
    const router = selection.provider === "openrouter";
    const url = router ? "https://openrouter.ai/api/v1/chat/completions" : custom;
    const key = router ? env.AGS_OPENROUTER_API_KEY : env.AGS_CUSTOM_API_KEY;
    if (!url || (router && !key) || selection.provider === "mock") throw new ProviderError("provider_failed");
    try {
      const response = await send(url, {
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
          messages: [{ role: "system", content: instructions[preset] }, ...messages],
        }),
      });
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")
      ) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new ProviderError("provider_auth");
        throw new ProviderError(response.status === 429 ? "provider_limit" : "provider_failed");
      }
      yield* readReply(response.body);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("provider_failed");
    }
  }
  return { options, stream };
}
