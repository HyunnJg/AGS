import { defaultClaudeOutput } from "../../../packages/providers/src/anthropic.ts";
import { callStatus } from "../../../packages/providers/src/capture.ts";
import { runReview } from "./reviews.ts";
import { type Connections, ConnectionError } from "./connections.ts";
import { CheckpointService } from "./checkpoints.ts";
import { loadSectionState, loadCheckpoints } from "./section-state.ts";
import { workspaceApi } from "./workspace-api.ts";
import { checkKnowledgeSource } from "./knowledge-source.ts";
import { WorkspaceError } from "./workspace-files.ts";
import { ruleError, type DisplayRule } from "../../../packages/contracts/src/display.ts";
import { isBlockOrder, isResponseLanguage, maxSourceLength } from "../../../packages/contracts/src/context.ts";
import { assembleContext } from "./context.ts";
import { type ContextLimits, isLimits, maxPromptLength } from "../../../packages/contracts/src/context.ts";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { encodeEvent, isChatRequest, type ChatEvent } from "../../../packages/contracts/src/chat.ts";
import { type Session, maxTurnSearchQuery, validSessionTitle, isPreset, isCustomPresetId, isPresetDraft } from "../../../packages/contracts/src/sessions.ts";
import { isConnectionId, isModelSelection } from "../../../packages/contracts/src/providers.ts";
import { configureProviders, ProviderError } from "../../../packages/providers/src/compatible.ts";
import { streamMock } from "../../../packages/providers/src/mock.ts";
import type { SessionStore } from "./sessions.ts";
import { serveWeb } from "./web.ts";

const maxBodyBytes = 64 * 1024;
const cancelRoute = /^\/api\/chat\/([a-f0-9-]{36})\/cancel$/;

class RequestError extends Error {
  status: number;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

function rejectRequest(res: ServerResponse, status: number, code: string) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(JSON.stringify({ error: code }));
}

async function readBody(req: IncomingMessage, limit = maxBodyBytes): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "expected_json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, "body_too_large");
    chunks.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new RequestError(400, "invalid_json");
  }
  return body;
}

type Provider = (message: string, signal: AbortSignal, preset?: string) => AsyncIterable<string>;

export function createChatServer(
  token: string,
  provider: Provider = streamMock,
  timeoutMs = 60_000,
  store?: SessionStore,
  providers = configureProviders({}),
  { totalTimeoutMs = 600_000, stateDirectory = "", connections }: { totalTimeoutMs?: number; stateDirectory?: string; connections?: Connections } = {},
) {
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)) throw new Error("invalid_local_token");
  if (connections) providers = connections.adapters;
  if (store)
    store.protectCall = (capture) => {
      capture.protect(token);
      providers.protect(capture);
    };
  const authorization = Buffer.from(`Bearer ${token}`);
  const active = new Map<string, AbortController>();

  const checkpoints = new CheckpointService();
  function memoryFor(db: SessionStore, section: Session["sectionId"]) {
    return Promise.all([loadSectionState(db, section), loadCheckpoints(db, section)]);
  }
  function contextFor(
    db: SessionStore,
    session: Session,
    message: string,
    [state, summaries]: Awaited<ReturnType<typeof memoryFor>>,
    limits: ContextLimits = db.limits(session.id),
  ) {
    const shared = db.promptSettings();
    const current =
      state && session.sectionId && db.activeState(session.sectionId)?.key === state.key ? state : undefined;
    const enabled = db.memoryEnabled();
    const refs =
      session.sectionId && enabled && summaries.length ? db.recentCheckpoints(session.sectionId) : [];
    const pinned = summaries.filter((s) => refs.some((r) => r.path === s.path && r.version === s.version));
    const texts = pinned.map((s) => s.text).filter(Boolean);
    const assembled = assembleContext(
      db.presetContent(session.preset),
      shared.prompt,
      session.provider === "anthropic" && limits.outputBudget === null ? { ...limits, outputBudget: defaultClaudeOutput } : limits,
      db.history(session.id, limits.turns),
      message,
      providers.contextWindow(session.provider, session.model) ?? null,
      shared.order,
      db.sources(session.id),
      db.references(session.id),
      current?.text,
      texts,
      shared.responseLanguage,
    );
    const included = new Set(
      assembled.messages.filter((_, i) => assembled.blocks[i] === "memory").map((m) => m.content),
    );
    return {
      ...assembled,
      stateStale: !!current?.stale,
      memoryUse: {
        enabled,
        state: !!current?.text && included.has(current.text),
        summaries: texts.filter((t) => included.has(t)).length,
        stale: pinned.filter((s) => !s.text).length + Number(!!current?.stale),
        omitted:
          texts.filter((t) => !included.has(t)).length +
          Number(!!current?.text && !included.has(current.text)),
      },
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host?.toLowerCase();
    const suffix = req.socket.localPort === 80 ? "" : `:${req.socket.localPort}`;
    if (host !== `127.0.0.1${suffix}` && host !== `localhost${suffix}`) {
      throw new RequestError(403, "invalid_host");
    }
    if (req.headers.origin !== undefined && req.headers.origin.toLowerCase() !== `http://${host}`) {
      throw new RequestError(403, "invalid_origin");
    }
    const path = req.url ?? "";
    if (req.method === "GET" && (await serveWeb(path, res))) return;
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      throw new RequestError(401, "unauthorized");
    }

    function json(value: unknown, status = 200) {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    }
    function allow(methods: string) {
      res.setHeader("Allow", methods);
      throw new RequestError(405, "method_not_allowed");
    }
    if (path === "/api/providers") {
      if (req.method !== "GET") return allow("GET");
      return json(providers.options);
    }
    const connection = /^\/api\/settings\/connections\/([^/]+)$/.exec(path);
    if (connections && isConnectionId(connection?.[1])) {
      const id = connection[1];
      if (req.method === "GET") return json(connections.view(id));
      if (req.method !== "PUT") return allow("GET, PUT");
      const view = await connections.save(id, await readBody(req));
      providers = connections.adapters;
      return json({ view, options: providers.options });
    }
    if (path === "/api/settings/call-logs" && store) {
      if (req.method === "PUT") {
        const body = await readBody(req);
        if (!body || typeof body !== "object" || !("enabled" in body) || typeof body.enabled !== "boolean")
          throw new RequestError(400, "invalid_setting");
        store.setLogsEnabled(body.enabled);
      } else if (req.method !== "GET") return allow("GET, PUT");
      return json({ enabled: store.logsEnabled() });
    }
    if (path === "/api/call-logs?usage=1" && store) {
      if (req.method !== "GET") return allow("GET");
      return json(store.callList(true));
    }
    const logRoute = /^\/api\/call-logs(?:\/(export|[a-f0-9-]{36}))?$/.exec(path);
    if (logRoute && store) {
      if (!logRoute[1] && req.method === "DELETE") return json({ deleted: store.clearCallLogs() });
      if (logRoute[1] === "export") {
        if (req.method === "GET") return json(store.callDetails());
        if (req.method !== "POST") return allow("GET, POST");
        const body = await readBody(req);
        const ids = body && typeof body === "object" && "ids" in body ? body.ids : undefined;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 ||
            !ids.every(id => typeof id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) ||
            new Set(ids).size !== ids.length)
          throw new RequestError(400, "invalid_call_selection");
        const entries = store.callDetails(ids);
        if (entries.length !== ids.length) throw new RequestError(409, "call_selection_changed");
        return json(entries);
      }
      if (req.method !== "GET") return allow(logRoute[1] ? "GET" : "GET, DELETE");
      if (!logRoute[1]) return json(store.callList());
      const entry = store.callDetails(logRoute[1])[0];
      if (!entry) throw new RequestError(404, "unknown_call");
      return json(entry);
    }
    const catalog = /^\/api\/providers\/([^/]+)\/models(\?refresh=1)?$/.exec(path);
    if (catalog && (catalog[1] === "mock" || isConnectionId(catalog[1]))) {
      if (req.method !== "GET") return allow("GET");
      const option = providers.options.find((item) => item.id === catalog[1]);
      if (!option?.enabled) throw new RequestError(400, "provider_unavailable");
      try {
        return json(
          await providers.models(option.id, Boolean(catalog[2]), () =>
            store?.startCall("catalog", { provider: option.id, model: "" }, null),
          ),
        );
      } catch (error) {
        throw new RequestError(502, error instanceof ProviderError && error.code === "provider_auth" ? "provider_auth" : "catalog_unavailable");
      }
    }
    if (path === "/api/settings/display-rules" && store) {
      if (req.method === "GET") return json(store.displaySettings());
      if (req.method !== "PUT") return allow("GET, PUT");
      const body = await readBody(req);
      if (
        !body ||
        typeof body !== "object" ||
        !("revision" in body) ||
        typeof body.revision !== "number" ||
        !Number.isSafeInteger(body.revision) ||
        body.revision < 0 ||
        !("rules" in body) ||
        ruleError(body.rules)
      )
        throw new RequestError(400, "invalid_rules");
      if (!store.setDisplayRules(body.revision, body.rules as DisplayRule[]))
        throw new RequestError(409, "settings_changed");
      return json(store.displaySettings());
    }
    if (path === "/api/settings/presets" && store) {
      if (req.method === "GET") return json(store.customPresets());
      if (req.method !== "POST") return allow("GET, POST");
      const body = await readBody(req);
      if (!isPresetDraft(body)) throw new RequestError(400, "invalid_preset");
      return json(store.addPreset(body.name.trim(), body.instructions));
    }
    if (path === "/api/settings/presets?includeArchived=1" && store) {
      if (req.method !== "GET") return allow("GET");
      return json(store.customPresets(true));
    }
    const presetRoute = /^\/api\/settings\/presets\/([^/]+)(\/archive)?$/.exec(path);
    const customId = presetRoute?.[1];
    if (store && isCustomPresetId(customId)) {
      if (presetRoute?.[2]) {
        if (req.method !== "PUT") return allow("PUT");
        const body = await readBody(req);
        if (!body || typeof body !== "object" || !("archived" in body) || typeof body.archived !== "boolean")
          throw new RequestError(400, "invalid_preset");
        store.setPresetArchived(customId, body.archived);
        return json({ archived: body.archived });
      }
      if (req.method !== "GET") return allow("GET");
      return json(store.presetContent(customId));
    }
    if (path === "/api/settings/response-language" && store) {
      if (req.method === "GET") return json({ language: store.promptSettings().responseLanguage });
      if (req.method !== "PUT") return allow("GET, PUT");
      const body = await readBody(req);
      if (!body || typeof body !== "object" ||
          !("language" in body) || !isResponseLanguage(body.language) ||
          !("previous" in body) || !isResponseLanguage(body.previous))
        throw new RequestError(400, "invalid_language");
      if (!store.setResponseLanguage(body.language, body.previous))
        throw new RequestError(409, "settings_changed");
      return json({ language: body.language });
    }
    if (path === "/api/settings/prompt" && store) {
      if (req.method === "GET") return json(store.promptSettings());
      if (req.method !== "PUT") return allow("GET, PUT");
      const body = await readBody(req);
      if (
        !body ||
        typeof body !== "object" ||
        !("prompt" in body) ||
        typeof body.prompt !== "string" ||
        body.prompt.length > maxPromptLength ||
        !("previous" in body) ||
        typeof body.previous !== "string"
      )
        throw new RequestError(400, "invalid_prompt");
      if ("order" in body || "previousOrder" in body) {
        if (
          !("order" in body) ||
          !isBlockOrder(body.order) ||
          !("previousOrder" in body) ||
          !isBlockOrder(body.previousOrder)
        )
          throw new RequestError(400, "invalid_order");
        if (
          !store.setPromptSettings(
            { prompt: body.prompt, order: body.order },
            body.previous,
            body.previousOrder,
          )
        )
          throw new RequestError(409, "settings_changed");
      } else if (!store.setPrompt(body.prompt, body.previous))
        throw new RequestError(409, "settings_changed");
      return json(store.promptSettings());
    }
    if (store && path === "/api/settings/collaboration") {
      if (req.method === "PUT") {
        const body = await readBody(req);
        if (!body || typeof body !== "object" || !("enabled" in body) || typeof body.enabled !== "boolean")
          throw new RequestError(400, "invalid_setting");
        store.setCollaborationEnabled(body.enabled);
      } else if (req.method !== "GET") return allow("GET, PUT");
      return json({ enabled: store.collaborationEnabled() });
    }
    if (store && ["/api/settings/section-memory", "/api/settings/memory-update", "/api/settings/knowledge"].includes(path)) {
      const knowledge = path.endsWith("/knowledge");
      const updating = path.endsWith("memory-update");
      if (req.method === "PUT") {
        const body = await readBody(req);
        if (!body || typeof body !== "object" || !("enabled" in body) || typeof body.enabled !== "boolean")
          throw new RequestError(400, "invalid_setting");
        if (knowledge) store.setKnowledgeEnabled(body.enabled);
        else if (updating) store.setUpdateMemoryEnabled(body.enabled);
        else store.setMemoryEnabled(body.enabled);
      } else if (req.method !== "GET") return allow("GET, PUT");
      return json({ enabled: knowledge ? store.knowledgeEnabled() : updating ? store.updateMemoryEnabled() : store.memoryEnabled() });
    }
    if (path === "/api/settings/runtime") {
      if (req.method !== "GET") return allow("GET");
      return json({ idleTimeoutMs: timeoutMs, totalTimeoutMs, stateDirectory });
    }
    if (path === "/api/settings/favorites" && store) {
      if (req.method === "GET") return json(store.favorites());
      if (req.method !== "PUT") return allow("GET, PUT");
      const body = await readBody(req);
      if (
        !isModelSelection(body) ||
        body.provider === "mock" ||
        !("pinned" in body) ||
        typeof body.pinned !== "boolean"
      )
        throw new RequestError(400, "invalid_favorite");
      store.setFavorite(body, body.pinned);
      return json(store.favorites());
    }
    if ((path === "/api/projects" || path.startsWith("/api/projects/")) && store)
      return workspaceApi(path, req, store, stateDirectory, readBody, json, allow);
    if (path === "/api/sessions/search" && store) {
      if (req.method !== "POST") return allow("POST");
      const body = await readBody(req);
      const query = body && typeof body === "object" && "query" in body && typeof body.query === "string"
        ? body.query.trim().normalize("NFC") : "";
      if (!query || query.length > maxTurnSearchQuery || !query.isWellFormed() || query.includes("\0"))
        throw new RequestError(400, "invalid_search_query");
      const matches = await store.searchTurns(query, () => res.destroyed);
      if (!res.destroyed) return json(matches);
      return;
    }
    if (path === "/api/sessions" && store) {
      if (req.method === "GET") return json(store.list());
      if (req.method === "POST") {
        let sectionId: string | null = null;
        if (Number(req.headers["content-length"]) || req.headers["transfer-encoding"]) {
          const selection = await readBody(req);
          if (selection && typeof selection === "object" && "sectionId" in selection) {
            if (typeof selection.sectionId !== "string" || !store.sectionExists(selection.sectionId))
              throw new RequestError(400, "invalid_section");
            sectionId = selection.sectionId;
          }
          if (isModelSelection(selection)) {
            if (!providers.options.find((o) => o.id === selection.provider)?.enabled)
              throw new RequestError(400, "invalid_model");
            return json(store.create(selection, sectionId), 201);
          }
          if (!sectionId || Object.keys(selection as object).length !== 1)
            throw new RequestError(400, "invalid_model");
        }
        const preferred = providers.options.find(o =>
          (o.id !== "mock" && o.id !== "custom") && o.enabled &&
          isModelSelection({ provider: o.id, model: o.defaultModel }),
        );
        const selection = preferred && { provider: preferred.id, model: preferred.defaultModel };
        return json(store.create(selection, sectionId), 201);
      }
      return allow("GET, POST");
    }
    const reviewRoute = /^\/api\/sessions\/([a-f0-9-]{36})\/review(?:\/(history|[a-f0-9-]{36}))?$/.exec(path);
    if (reviewRoute?.[1] && store) {
      const id = reviewRoute[1];
      if (!store.get(id)) throw new RequestError(404, "unknown_session");
      const entry = reviewRoute[2];
      if (entry) {
        if (req.method !== "GET") return allow("GET");
        if (entry === "history") return json(store.reviewHistory(id));
        const result = store.review(id, entry);
        if (!result) throw new RequestError(404, "unknown_review");
        return json(result);
      }
      if (req.method === "GET") return json(store.review(id) ?? null);
      if (req.method !== "POST") return allow("GET, POST");
      const body = await readBody(req);
      if (res.destroyed) return;
      const controller = new AbortController();
      let reviewId: string | undefined;
      const abort = () => controller.abort();
      res.once("close", abort);
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(totalTimeoutMs)]);
        const result = await runReview(store, id, body, providers, signal, turn => {
          reviewId = turn;
          active.set(turn, controller);
        });
        return json(result);
      } finally {
        if (reviewId) active.delete(reviewId);
        res.off("close", abort);
      }
    }
    const references =
      /^\/api\/sessions\/([a-f0-9-]{36})\/references(?:\/([a-f0-9-]{36})(\/check)?)?$/.exec(path);
    if (references && store) {
      const sessionId = references[1] as string;
      if (!store.get(sessionId)) throw new RequestError(404, "unknown_session");
      if (!references[2]) return req.method === "GET" ? json(store.references(sessionId)) : allow("GET");
      if (references[3]) {
        if (req.method !== "POST") return allow("POST");
        return json(await checkKnowledgeSource(store, sessionId, references[2]));
      }
      if (req.method !== "DELETE") return allow("DELETE");
      store.removeReference(sessionId, references[2]);
      return json(store.references(sessionId));
    }
    const route =
      /^\/api\/sessions\/([a-f0-9-]{36})(\/chat|\/context|\/context-preview|\/checkpoint|\/sources|\/title|\/archive|\/section)?$/.exec(
        path,
      );
    let session = route?.[1] && store ? store.get(route[1]) : undefined;
    if (route && !session) throw new RequestError(404, "unknown_session");
    if (session && store && route?.[2] === "/section") {
      if (req.method !== "PUT") return allow("PUT");
      const body = await readBody(req);
      if (!body || typeof body !== "object" || !("sectionId" in body)) throw new RequestError(400, "invalid_section");
      const revision = "sectionRevision" in body ? body.sectionRevision : undefined;
      if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0))
        throw new RequestError(400, "invalid_section");
      if (body.sectionId === null && "previousSectionId" in body && typeof body.previousSectionId === "string" && revision !== undefined) {
        if (checkpoints.isBusy(session.id)) throw new RequestError(409, "checkpoint_busy");
        return json(store.changeSessionSection(session.id, null, body.previousSectionId, revision));
      }
      if (typeof body.sectionId !== "string" || ("previousSectionId" in body && body.previousSectionId !== null))
        throw new RequestError(400, "invalid_section");
      // Older clients can still make a first assignment, but cannot replay it after an unlink.
      return json(store.changeSessionSection(session.id, body.sectionId, null, revision ?? 0));
    }
    if (session && store && route?.[2] === "/archive") {
      if (req.method !== "PUT") return allow("PUT");
      const body = await readBody(req);
      if (!body || typeof body !== "object" || !("archived" in body) || typeof body.archived !== "boolean")
        throw new RequestError(400, "invalid_archive");
      store.setSessionArchived(session.id, body.archived);
      return json({ archived: body.archived });
    }
    if (session && store && route?.[2] === "/title") {
      if (req.method !== "PUT") return allow("PUT");
      const body = await readBody(req);
      if (!body || typeof body !== "object" || !("title" in body) || !validSessionTitle(body.title) ||
          !("previous" in body) || typeof body.previous !== "string") throw new RequestError(400, "invalid_title");
      const title = body.title.trim();
      if (!store.rename(session.id, body.previous, title))
        return json({ error: "title_changed", title: store.get(session.id)?.title }, 409);
      return json({ title });
    }
    if (session && store && route?.[2] === "/checkpoint") {
      if (req.method !== "POST") return allow("POST");
      const body = await readBody(req);
      if(res.destroyed) return;
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once("close", abort);
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(totalTimeoutMs)]);
        return json(
          await checkpoints.run(
            store,
            store.get(session.id) ?? session,
            body,
            providers,
            stateDirectory,
            signal,
          ),
        );
      } finally {
        res.off("close", abort);
      }
    }
    if (session && store && route?.[2] === "/sources") {
      if (req.method === "GET") return json(store.sources(session.id));
      if (req.method !== "PUT") return allow("GET, PUT");
      const data = await readBody(req);
      if (
        !data ||
        typeof data !== "object" ||
        !("memory" in data) ||
        typeof data.memory !== "string" ||
        data.memory.length > maxSourceLength ||
        !("retrieval" in data) ||
        typeof data.retrieval !== "string" ||
        data.retrieval.length > maxSourceLength ||
        !("revision" in data) ||
        typeof data.revision !== "number" ||
        !Number.isSafeInteger(data.revision) ||
        data.revision < 0
      )
        throw new RequestError(400, "invalid_sources");
      if (
        !store.setSources(session.id, {
          memory: data.memory,
          retrieval: data.retrieval,
          revision: data.revision,
        })
      )
        throw new RequestError(409, "settings_changed");
      return json(store.sources(session.id));
    }
    if (session && store && route?.[2] === "/context") {
      if (req.method === "GET") return json(store.limits(session.id));
      if (req.method !== "PUT") return allow("GET, PUT");
      const limits = await readBody(req);
      if (!isLimits(limits)) throw new RequestError(400, "invalid_limits");
      store.setLimits(session.id, limits);
      return json(store.limits(session.id));
    }
    if (session && store && route?.[2] === "/context-preview") {
      if (req.method !== "POST") return allow("POST");
      const body = await readBody(req);
      if (
        !body ||
        typeof body !== "object" ||
        !("message" in body) ||
        typeof body.message !== "string" ||
        !("limits" in body) ||
        !isLimits(body.limits)
      )
        throw new RequestError(400, "invalid_preview");
      session = store.get(session.id) ?? session;
      const state = await memoryFor(store, session.sectionId);
      const latest = store.get(session.id) ?? session;
      if (latest.sectionRevision !== session.sectionRevision) throw new RequestError(409, "session_section_changed");
      return json(contextFor(store, latest, body.message, state, body.limits));
    }
    if (session && store && !route?.[2]) {
      if (req.method === "GET") return json({ session, turns: store.turns(session.id) });
      if (req.method !== "PATCH") return allow("GET, PATCH");
      const body = await readBody(req);
      if (isModelSelection(body)) {
        if (store.isStreaming(session.id)) throw new RequestError(409, "session_busy");
        if (!providers.options.find((o) => o.id === body.provider)?.enabled)
          throw new RequestError(400, "provider_unavailable");
        store.setModel(session.id, body);
        return json(store.get(session.id));
      }
      if (!body || typeof body !== "object" || !("preset" in body) || !isPreset(body.preset)) {
        throw new RequestError(400, "invalid_preset");
      }
      if (isCustomPresetId(body.preset)) store.presetContent(body.preset);
      store.setPreset(session.id, body.preset);
      return json(store.get(session.id));
    }
    const cancelId = cancelRoute.exec(req.url ?? "")?.[1];
    if (!session && !cancelId && req.url !== "/api/chat") throw new RequestError(404, "not_found");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      throw new RequestError(405, "method_not_allowed");
    }
    if (cancelId) {
      const controller = active.get(cancelId);
      if (!controller) throw new RequestError(404, "not_active");
      controller.abort();
      res.writeHead(204).end();
      return;
    }

    const body = await readBody(req);
    if (!isChatRequest(body)) throw new RequestError(400, "invalid_message");
    const { message } = body;
    if (res.destroyed) return;
    // Read settings at admission, after receiving the complete request body.
    if (session && store) session = store.get(session.id);
    const revisionAtAdmission = session?.sectionRevision;
    const state = session && store ? await memoryFor(store, session.sectionId) : undefined;
    if (res.destroyed) return;
    if (session && store) session = store.get(session.id);
    if (session?.sectionRevision !== revisionAtAdmission) throw new RequestError(409, "session_section_changed");
    const context = session && store && state ? contextFor(store, session, message, state) : undefined;
    if (context && !context.fits) throw new RequestError(422, "input_budget_exceeded");
    const id = randomUUID();
    if (session && !store?.begin(session, id, message)) throw new RequestError(409, "session_busy");
    const controller = new AbortController();
    const { signal } = controller;
    const disconnected = () => controller.abort();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    const deadline = setTimeout(() => controller.abort("timeout"), totalTimeoutMs);
    active.set(id, controller);
    res.once("close", disconnected);
    let storageFailed = false;
    let pending = "";
    let checkpoint: ReturnType<typeof setTimeout> | undefined;
    function flush() {
      clearTimeout(checkpoint);
      checkpoint = undefined;
      if (pending) {
        try {
          store?.append(id, pending);
          pending = "";
        } catch (error) {
          storageFailed = true;
          throw error;
        }
      }
    }
    function saveChunk(text: string) {
      if (!session) return;
      pending += text;
      if (pending.length >= 8192) flush();
      else if (!checkpoint)
        checkpoint = setTimeout(() => {
          try {
            flush();
          } catch {
            controller.abort("storage_failed");
          }
        }, 150);
    }
    const capture = store?.startCall(
      "chat",
      session ?? { provider: "mock", model: "" },
      session?.id ?? null,
      session?.provider === "mock" ? undefined : context,
    );
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-request-id": id,
        ...(session?.sectionId && context && { "x-ags-memory-use": JSON.stringify(context.memoryUse) }),
        ...(context?.stateStale && { "x-ags-section-state": "stale" }),
      });
      res.flushHeaders();
      const reply =
        session && session.provider !== "mock" && context
          ? providers.stream(
              session,
              context.messages,
              signal,
              () => timer.refresh(),
              context.outputBudget,
              capture,
            )
          : provider(message, signal, isCustomPresetId(session?.preset) ? "사용자 프리셋" : session?.preset);
      for await (const text of reply) {
        signal.throwIfAborted();
        timer.refresh();
        capture?.answer(text);
        saveChunk(text);
        if (!res.write(encodeEvent({ type: "delta", text }))) {
          await once(res, "drain", { signal });
        }
      }
      signal.throwIfAborted();
      flush();
      try {
        if (session) store?.finish(id, "completed");
      } catch (error) {
        storageFailed = true;
        throw error;
      }
      capture?.finish("completed");
      res.end(encodeEvent({ type: "done" }));
    } catch (error) {
      capture?.finish(storageFailed ? "failed" : callStatus(signal));
      try {
        flush();
      } catch {
        storageFailed = true;
      }
      const cancelled = signal.aborted && signal.reason !== "timeout" && signal.reason !== "storage_failed";
      try {
        if (session) store?.finish(id, cancelled && !storageFailed ? "cancelled" : "failed");
      } catch {
        storageFailed = true;
      }
      if (!res.destroyed) {
        const terminal: ChatEvent = storageFailed
          ? { type: "error", code: "storage_failed" }
          : cancelled
            ? { type: "cancelled" }
            : {
                type: "error",
                code:
                  signal.reason === "timeout"
                    ? "timeout"
                    : error instanceof ProviderError
                      ? error.code
                      : "provider_failed",
              };
        res.end(encodeEvent(terminal));
      }
    } finally {
      clearTimeout(checkpoint);
      clearTimeout(timer);
      clearTimeout(deadline);
      active.delete(id);
      res.off("close", disconnected);
    }
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      if (err instanceof RequestError || err instanceof WorkspaceError || err instanceof ConnectionError)
        rejectRequest(res, err.status, err.message);
      else rejectRequest(res, 500, "internal_error");
    });
  });
  return Object.assign(server, {
    stopStreams() {
      for (const controller of active.values()) controller.abort();
    },
  });
}
