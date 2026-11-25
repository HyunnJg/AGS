import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { encodeEvent, isChatRequest, type ChatEvent } from "../../../packages/contracts/src/chat.ts";
import { isPreset, type Preset } from "../../../packages/contracts/src/sessions.ts";
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
) {
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)) throw new Error("invalid_local_token");
  const authorization = Buffer.from(`Bearer ${token}`);
  const active = new Map<string, AbortController>();

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
    if (path === "/api/sessions" && store) {
      if (req.method === "GET") return json(store.list());
      if (req.method === "POST") {
        const router = providers.options.find((o) => o.id === "openrouter" && o.enabled);
        const selection = { provider: "openrouter", model: router?.defaultModel };
        return json(store.create(isModelSelection(selection) ? selection : undefined), 201);
      }
      return allow("GET, POST");
    }
    const route = /^\/api\/sessions\/([a-f0-9-]{36})(\/chat)?$/.exec(path);
    let session = route?.[1] && store ? store.get(route[1]) : undefined;
    if (route && !session) throw new RequestError(404, "unknown_session");
    if (session && store && !route?.[2]) {
      if (req.method === "GET") return json({ session, turns: store.turns(session.id) });
      if (req.method !== "PATCH") return allow("GET, PATCH");
      const body = await readBody(req);
      if (isModelSelection(body)) {
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
    const id = randomUUID();
    if (session && !store?.begin(session, id, message)) throw new RequestError(409, "session_busy");
    const controller = new AbortController();
    const { signal } = controller;
    const disconnected = () => controller.abort();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    active.set(id, controller);
    res.once("close", disconnected);
    let pending = "";
    let checkpoint: ReturnType<typeof setTimeout> | undefined;
    function flush() {
      clearTimeout(checkpoint);
      checkpoint = undefined;
      if (pending) {
        store?.append(id, pending);
        pending = "";
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
        session && session.provider !== "mock" && store
          ? providers.stream(
              session,
              session.preset,
              [...store.history(session.id), { role: "user", content: message }],
              signal,
            )
          : provider(message, signal, session?.preset);
      for await (const text of reply) {
        signal.throwIfAborted();
        saveChunk(text);
        if (!res.write(encodeEvent({ type: "delta", text }))) {
          await once(res, "drain", { signal });
        }
      }
      signal.throwIfAborted();
      flush();
      if (session) store?.finish(id, "completed");
      res.end(encodeEvent({ type: "done" }));
    } catch (error) {
      flush();
      const cancelled = signal.aborted && signal.reason !== "timeout" && signal.reason !== "storage_failed";
      if (session) store?.finish(id, cancelled ? "cancelled" : "failed");
      if (!res.destroyed) {
        const terminal: ChatEvent = cancelled
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
      active.delete(id);
      res.off("close", disconnected);
    }
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      if (err instanceof RequestError) rejectRequest(res, err.status, err.message);
      else rejectRequest(res, 500, "internal_error");
    });
  });
  return Object.assign(server, {
    stopStreams() {
      for (const controller of active.values()) controller.abort();
    },
  });
}
