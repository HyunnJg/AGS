import { responsesPayload, responsesReply } from "./openai-responses.ts";
import { claudeFolderFinal, geminiFolderFinal, type FolderFollowup, requestFolderDecision } from "./folder-tools.ts";
import type { CallCapture } from "./capture.ts";
import { anthropicPayload, anthropicReply, defaultClaudeOutput } from "./anthropic.ts";
import { providerHeaders } from "./headers.ts";
import { ProviderError, responseError } from "./errors.ts";
export { ProviderError } from "./errors.ts";
import { geminiPayload, geminiReply } from "./gemini.ts";
import { createCatalog } from "./catalog.ts";
import {
  isModelSelection,
  isFolderProvider,
  type ModelSelection,
  type ProviderId,
  type ProviderOption,
} from "../../contracts/src/providers.ts";
import type { Message } from "../../contracts/src/context.ts";

export const officialBaseUrls = {
  anthropic: "https://api.anthropic.com/v1/",
  openai: "https://api.openai.com/v1/",
  gemini: "https://generativelanguage.googleapis.com/v1beta/",
  openrouter: "https://openrouter.ai/api/v1/",
} as const;

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

// Decode frames across arbitrary network and UTF-8 boundaries, including SSE comments.
async function* eventData(body: ReadableStream<Uint8Array>, onActivity?: () => void, capture?: CallCapture) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if ((pending + decoder.decode()).trim()) throw new ProviderError("provider_failed");
        return;
      }
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
        if (data) yield data;
      }
      if (pending.length > 2 * 1024 * 1024) throw new ProviderError("provider_failed");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* compatibleReply(events: AsyncIterable<string>, capture?: CallCapture) {
  let hasText = false;
  let reachedLimit = false;
  for await (const data of events) {
    if (data.trim() === "[DONE]") {
      if (reachedLimit && !hasText) throw new ProviderError("provider_output_budget");
      return;
    }
    const chunk = JSON.parse(data);
    capture?.recordCompatibleUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (chunk.error || choice?.finish_reason === "error") throw new ProviderError("provider_failed");
    if (choice?.finish_reason === "length") reachedLimit = true;
    for (const part of [choice?.delta?.content, choice?.delta?.refusal]) {
      if (typeof part === "string" && part) {
        if (part.trim()) hasText = true;
        yield part;
      }
    }
  }
  throw new ProviderError("provider_failed");
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
    {
      id: "openai",
      enabled: Boolean(env.AGS_OPENAI_API_KEY),
      defaultModel: env.AGS_OPENAI_MODEL?.trim() || "",
    },
    {
      id: "gemini",
      enabled: Boolean(env.AGS_GEMINI_API_KEY),
      defaultModel: env.AGS_GEMINI_MODEL?.trim() || "",
    },
    {
      id: "anthropic",
      enabled: Boolean(env.AGS_ANTHROPIC_API_KEY),
      defaultModel: env.AGS_ANTHROPIC_MODEL?.trim() || "",
    },
    { id: "custom", enabled: Boolean(custom), defaultModel: env.AGS_CUSTOM_MODEL?.trim() || "" },
  ];
  function endpoint(provider: ProviderId) {
    if (provider === "custom") return { url: custom, key: env.AGS_CUSTOM_API_KEY };
    if (provider === "mock") return { url: undefined, key: undefined };
    const key = env[`AGS_${provider.toUpperCase()}_API_KEY`];
    return { url: key ? officialBaseUrls[provider] : undefined, key };
  }
  async function* stream(
    selection: ModelSelection,
    messages: Message[],
    signal: AbortSignal,
    onActivity?: () => void,
    outputBudget?: number | null,
    capture?: CallCapture,
    folderResult?: FolderFollowup,
  ) {
    const { url, key } = endpoint(selection.provider);
    protect(capture);
    if (!url) throw new ProviderError("provider_failed");
    try {
      const { provider, model } = selection;
      if (!isModelSelection(selection)) throw new ProviderError("provider_failed");
      if (folderResult && provider !== folderResult.provider) throw new ProviderError("provider_failed");
      let path = "chat/completions";
      let payload: Record<string, unknown>;
      let reply: (events: AsyncIterable<string>, capture?: CallCapture, finalRound?: boolean) => AsyncIterable<string> = compatibleReply;
      if (provider === "anthropic") {
        path = "messages";
        outputBudget ??= defaultClaudeOutput;
        const initial = anthropicPayload(model, messages, outputBudget);
        payload = folderResult?.provider === "anthropic" ? { ...initial, ...claudeFolderFinal, messages: [...initial.messages, ...folderResult.messages] } : initial;
        reply = anthropicReply;
      } else if (provider === "gemini") {
        path = `models/${model}:streamGenerateContent?alt=sse`;
        const initial = geminiPayload(messages, outputBudget);
        payload = folderResult?.provider === "gemini"
          ? { ...initial, ...geminiFolderFinal, contents: [...initial.contents, ...folderResult.contents] }
          : initial;
        reply = geminiReply;
      } else if (folderResult?.provider === "openai") {
        path = "responses";
        payload = { ...responsesPayload(model, [...messages, ...folderResult.items], outputBudget), stream: true };
        reply = responsesReply;
      } else {
        payload = {
          model,
          stream: true,
          messages,
          ...(provider === "openai" && { stream_options: { include_usage: true } }),
          ...(outputBudget != null && {
            [provider === "openai" ? "max_completion_tokens" : "max_tokens"]: outputBudget,
          }),
        };
      }
      if (capture) {
        const extra = folderResult?.provider === "openai" ? folderResult.items.map(item => ({ content: JSON.stringify(item) }))
          : folderResult?.provider === "gemini"
          ? folderResult.contents.map(turn => ({ content: JSON.stringify(turn.parts) }))
          : folderResult?.messages.map(m => ({ content: JSON.stringify(m.content) })) ?? [];
        capture.recordRequest([...messages, ...extra], outputBudget);
      }
      const response = await send(new URL(path, url).href, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...providerHeaders(provider, key),
        },
        body: JSON.stringify(payload),
      });
      capture?.response(response);
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")
      ) {
        throw await responseError(provider, response, capture);
      }
      const events = eventData(response.body, onActivity, capture);
      yield* reply(events, capture, !!folderResult);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("provider_failed");
    }
  }
  function protect(capture?: CallCapture) {
    capture?.protect(
      env.AGS_CUSTOM_API_KEY,
      env.AGS_OPENROUTER_API_KEY,
      env.AGS_OPENAI_API_KEY,
      env.AGS_GEMINI_API_KEY,
      env.AGS_ANTHROPIC_API_KEY,
    );
  }
  async function folderDecision(selection: ModelSelection, messages: Message[], signal: AbortSignal,
    onActivity: () => void, maxTokens: number | null, capture?: CallCapture) {
    const { provider } = selection;
    const { url, key } = endpoint(provider);
    if (!url || !isFolderProvider(provider) || !isModelSelection(selection)) throw new ProviderError("provider_failed");
    protect(capture);
    const path = { openai: "responses", anthropic: "messages", gemini: `models/${selection.model}:generateContent` }[provider];
    return requestFolderDecision(provider, send, new URL(path, url).href, providerHeaders(provider, key),
      selection.model, messages, signal, onActivity, maxTokens, capture);
  }
  return { options, stream, folderDecision, protect, ...createCatalog(send, endpoint) };
}
