import { responseError } from "./errors.ts";
import { providerHeaders } from "./headers.ts";
import { callStatus, type CallCapture } from "./capture.ts";
import { isModelSelection, type CatalogModel, type ProviderId } from "../../contracts/src/providers.ts";

export function createCatalog(
  send: typeof fetch,
  endpoint: (id: ProviderId) => { url: string | undefined; key: string | undefined },
) {
  const cache = new Map<ProviderId, { expires: number; models: CatalogModel[] }>();
  const pending = new Map<ProviderId, Promise<CatalogModel[]>>();
  async function load(provider: ProviderId, startCapture?: () => CallCapture | undefined) {
    const signal = AbortSignal.timeout(8000);
    const { url, key } = endpoint(provider);
    const models = new Map<string, CatalogModel>();
    const seen = new Set<string>();
    let pageToken = "";
    let size = 0;
    do {
      const capture = startCapture?.();
      try {
        capture?.protect(key);
        if (!url) throw new Error("provider_unavailable");
        const path = new URL("models", url);
        const native = provider === "gemini";
        if (native) path.searchParams.set("pageSize", "1000");
        if (pageToken) path.searchParams.set(provider === "anthropic" ? "after_id" : "pageToken", pageToken);
        const response = await send(path.href, {
          redirect: "error",
          signal,
          headers: {
            accept: "application/json",
            ...providerHeaders(provider, key),
          },
        });
        capture?.response(response);
        if (!response.ok || !response.body) {
          throw await responseError(provider, response, capture);
        }
        const buffers: Uint8Array[] = [];
        for await (const chunk of response.body) {
          capture?.bytes(chunk);
          size += chunk.byteLength;
          if (size > 8 * 1024 * 1024) throw new Error("catalog_too_large");
          buffers.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(buffers).toString("utf8"));
        const items = native ? payload?.models : payload?.data;
        if (!Array.isArray(items)) throw new Error("invalid_catalog");
        for (const item of items) {
          if (
            native &&
            !(
              Array.isArray(item?.supportedGenerationMethods) &&
              item.supportedGenerationMethods.includes("generateContent") &&
              typeof item.name === "string" &&
              item.name.startsWith("models/")
            )
          )
            continue;
          const id = native ? item.name.slice(7) : item?.id;
          if (!isModelSelection({ provider, model: id }) || models.has(id) || (key && id.includes(key)))
            continue;
          const label = native ? item.displayName : provider === "anthropic" ? item.display_name : item.name;
          const name = typeof label === "string" && !(key && label.includes(key)) ? label.slice(0, 256) : id;
          // Gemini publishes separate input/output limits, not a combined context window.
          const contextLength =
            !native && Number.isSafeInteger(item.context_length) && item.context_length > 0
              ? item.context_length
              : undefined;
          models.set(id, { id, name, ...(contextLength && { contextLength }) });
        }
        pageToken = native ? (payload.nextPageToken ?? "") : "";
        if (provider === "anthropic" && payload.has_more) {
          if (!payload.last_id) throw new Error("invalid_catalog_cursor");
          pageToken = payload.last_id;
        }
        if (typeof pageToken !== "string" || seen.has(pageToken)) throw new Error("invalid_catalog_cursor");
        seen.add(pageToken);
        capture?.finish("completed");
      } catch (error) {
        capture?.finish(callStatus(signal));
        throw error;
      }
    } while (pageToken);
    const result = [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
    cache.set(provider, { models: result, expires: Date.now() + 300_000 });
    return result;
  }
  async function models(provider: ProviderId, refresh = false, startCapture?: () => CallCapture | undefined) {
    if (provider === "mock") return [];
    const current = cache.get(provider);
    if (!refresh && current && current.expires > Date.now()) return current.models;
    const active = pending.get(provider);
    if (active) return active;
    const request = load(provider, startCapture).finally(() => pending.delete(provider));
    pending.set(provider, request);
    return request;
  }
  function contextWindow(provider: ProviderId, model: string) {
    return cache.get(provider)?.models.find((row) => row.id === model)?.contextLength;
  }
  return { models, contextWindow };
}
