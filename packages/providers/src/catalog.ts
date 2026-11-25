import { isModelSelection, type CatalogModel, type ProviderId } from "../../contracts/src/providers.ts";

export function createCatalog(
  send: typeof fetch,
  endpoint: (id: ProviderId) => { url: string | undefined; key: string | undefined },
) {
  const cache = new Map<ProviderId, { expires: number; models: CatalogModel[] }>();
  const pending = new Map<ProviderId, Promise<CatalogModel[]>>();
  async function load(provider: ProviderId) {
    const { url, key } = endpoint(provider);
    if (!url) throw new Error("provider_unavailable");
    const response = await send(new URL("models", url).href, {
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: { accept: "application/json", ...(key && { authorization: `Bearer ${key}` }) },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("catalog_unavailable");
    }
    const buffers: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("catalog_too_large");
      buffers.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(buffers).toString("utf8"));
    if (!Array.isArray(payload?.data)) throw new Error("invalid_catalog");
    const models = new Map<string, CatalogModel>();
    for (const item of payload.data) {
      if (
        !isModelSelection({ provider, model: item?.id }) ||
        models.has(item.id) ||
        (key && item.id.includes(key))
      )
        continue;
      const name =
        typeof item.name === "string" && !(key && item.name.includes(key))
          ? item.name.slice(0, 256)
          : item.id;
      const contextLength =
        Number.isSafeInteger(item.context_length) && item.context_length > 0
          ? item.context_length
          : undefined;
      models.set(item.id, { id: item.id, name, contextLength });
    }
    const result = [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
    cache.set(provider, { models: result, expires: Date.now() + 300_000 });
    return result;
  }
  async function models(provider: ProviderId, refresh = false) {
    if (provider === "mock") return [];
    const current = cache.get(provider);
    if (!refresh && current && current.expires > Date.now()) return current.models;
    const active = pending.get(provider);
    if (active) return active;
    const request = load(provider).finally(() => pending.delete(provider));
    pending.set(provider, request);
    return request;
  }
  function contextWindow(provider: ProviderId, model: string) {
    return cache.get(provider)?.models.find((row) => row.id === model)?.contextLength;
  }
  return { models, contextWindow };
}
