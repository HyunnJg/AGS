import { workspaceApi } from "./workspace-api.ts";
import { WorkspaceError } from "./workspace-files.ts";
import { ruleError, type DisplayRule } from "../../../packages/contracts/src/display.ts";
import { isBlockOrder, maxSourceLength } from "../../../packages/contracts/src/context.ts";
import { assembleContext } from "./context.ts";
import { type ContextLimits, isLimits, maxPromptLength } from "../../../packages/contracts/src/context.ts";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { encodeEvent, isChatRequest, type ChatEvent } from "../../../packages/contracts/src/chat.ts";
import { type Session, isPreset, type Preset } from "../../../packages/contracts/src/sessions.ts";
import { isModelSelection } from "../../../packages/contracts/src/providers.ts";
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

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "expected_json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new RequestError(413, "body_too_large");
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

type Provider = (message: string, signal: AbortSignal, preset?: Preset) => AsyncIterable<string>;

export function createChatServer(
  token: string,
  provider: Provider = streamMock,
  timeoutMs = 60_000,
  store?: SessionStore,
  providers = configureProviders({}),
  { totalTimeoutMs = 600_000, stateDirectory = "" } = {},
) {
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)) throw new Error("invalid_local_token");
  const authorization = Buffer.from(`Bearer ${token}`);
  const active = new Map<string, AbortController>();

  function contextFor(
    db: SessionStore,
    session: Session,
    message: string,
    limits: ContextLimits = db.limits(session.id),
  ) {
    const shared = db.promptSettings();
    return assembleContext(
      session.preset,
      shared.prompt,
      limits,
      db.history(session.id, limits.turns),
      message,
      providers.contextWindow(session.provider, session.model) ?? null,
      shared.order,
      db.sources(session.id),
    );
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
    const catalog = /^\/api\/providers\/(mock|openrouter|custom)\/models(\?refresh=1)?$/.exec(path);
    if (catalog) {
      if (req.method !== "GET") return allow("GET");
      const option = providers.options.find((item) => item.id === catalog[1]);
      if (!option?.enabled) throw new RequestError(400, "provider_unavailable");
      try {
        return json(await providers.models(option.id, Boolean(catalog[2])));
      } catch {
        throw new RequestError(502, "catalog_unavailable");
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
        const router = providers.options.find((o) => o.id === "openrouter" && o.enabled);
        const selection = { provider: "openrouter", model: router?.defaultModel };
        return json(store.create(isModelSelection(selection) ? selection : undefined, sectionId), 201);
      }
      return allow("GET, POST");
    }
    const route = /^\/api\/sessions\/([a-f0-9-]{36})(\/chat|\/context|\/context-preview|\/sources)?$/.exec(
      path,
    );
    let session = route?.[1] && store ? store.get(route[1]) : undefined;
    if (route && !session) throw new RequestError(404, "unknown_session");
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
      return json(contextFor(store, store.get(session.id) ?? session, body.message, body.limits));
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
    const context = session && store ? contextFor(store, session, message) : undefined;
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
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-request-id": id,
      });
      res.flushHeaders();
      const reply =
        session && session.provider !== "mock" && context
          ? providers.stream(session, context.messages, signal, () => timer.refresh(), context.outputBudget)
          : provider(message, signal, session?.preset);
      for await (const text of reply) {
        signal.throwIfAborted();
        timer.refresh();
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
      res.end(encodeEvent({ type: "done" }));
    } catch (error) {
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
      if (err instanceof RequestError || err instanceof WorkspaceError) rejectRequest(res, err.status, err.message);
      else rejectRequest(res, 500, "internal_error");
    });
  });
  return Object.assign(server, {
    stopStreams() {
      for (const controller of active.values()) controller.abort();
    },
  });
}
