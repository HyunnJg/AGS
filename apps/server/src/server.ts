import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { encodeEvent, isChatRequest, type ChatEvent } from "../../../packages/contracts/src/chat.ts";
import { streamMock } from "../../../packages/providers/src/mock.ts";

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
    "connection": "close",
  });
  res.end(JSON.stringify({ error: code }));
}

async function readMessage(req: IncomingMessage) {
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
  if (!isChatRequest(body)) throw new RequestError(400, "invalid_message");
  return body.message;
}

type Provider = (message: string, signal: AbortSignal) => AsyncIterable<string>;

export function createChatServer(token: string, provider: Provider = streamMock, timeoutMs = 60_000) {
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)) throw new Error("invalid_local_token");
  const authorization = Buffer.from(`Bearer ${token}`);
  const active = new Map<string, AbortController>();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host;
    const suffix = req.socket.localPort === 80 ? "" : `:${req.socket.localPort}`;
    if (host !== `127.0.0.1${suffix}` && host !== `localhost${suffix}`) {
      throw new RequestError(403, "invalid_host");
    }
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) {
      throw new RequestError(403, "invalid_origin");
    }
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      throw new RequestError(401, "unauthorized");
    }

    const cancelId = cancelRoute.exec(req.url ?? "")?.[1];
    if (!cancelId && req.url !== "/api/chat") throw new RequestError(404, "not_found");
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

    const message = await readMessage(req);
    if (res.destroyed) return;
    const id = randomUUID();
    const controller = new AbortController();
    const { signal } = controller;
    const disconnected = () => controller.abort();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    active.set(id, controller);
    res.once("close", disconnected);
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-request-id": id,
      });
      res.flushHeaders();
      for await (const text of provider(message, signal)) {
        signal.throwIfAborted();
        if (!res.write(encodeEvent({ type: "delta", text }))) {
          await once(res, "drain", { signal });
        }
      }
      signal.throwIfAborted();
      res.end(encodeEvent({ type: "done" }));
    } catch {
      if (!res.destroyed) {
        const terminal: ChatEvent = signal.aborted && signal.reason !== "timeout"
          ? { type: "cancelled" }
          : { type: "error", code: signal.reason === "timeout" ? "timeout" : "provider_failed" };
        res.end(encodeEvent(terminal));
      }
    } finally {
      clearTimeout(timer);
      active.delete(id);
      res.off("close", disconnected);
    }
  }

  return createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.destroyed) return;
      if (err instanceof RequestError) rejectRequest(res, err.status, err.message);
      else rejectRequest(res, 500, "internal_error");
    });
  });
}
