import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configureProviders } from "../packages/providers/src/compatible.ts";
import { createChatServer } from "../apps/server/src/server.ts";
import { SessionStore } from "../apps/server/src/sessions.ts";

const secret = "fixture-private-value-DO-NOT-RETURN";
async function listen(t: TestContext, server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
test(
  "호환 HTTP와 세션 API를 통해 오류 격리·부분 응답·인증·이력·취소를 검증한다",
  { timeout: 12000 },
  async (t) => {
    const requests: { model: string; messages: { role: string; content: string }[] }[] = [];
    const closed = Promise.withResolvers<void>();
    let mode = "success";
    const upstream = await listen(
      t,
      createServer(async (req, res) => {
        assert.equal(req.url, "/v1/chat/completions");
        assert.equal(req.headers.authorization, `Bearer ${secret}`);
        const parts = [];
        for await (const part of req) parts.push(part);
        requests.push(JSON.parse(Buffer.concat(parts).toString()));
        if (mode === "network") return req.socket.destroy();
        if (/^\d+$/.test(mode)) {
          res.writeHead(Number(mode)).end(secret);
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (mode === "burst") {
          res.write('data: {"choices":[{"delta":{"content":"가"}}]}\n\n'.repeat(200));
          res.end("data: [DONE]\n\n");
          return;
        }
        const frame = Buffer.from(
          ': keepalive\r\n\r\ndata: {"choices":[{"delta":{"content":"한글"}}]}\r\n\r\n',
        );
        const mid = frame.indexOf(Buffer.from("한")) + 1;
        res.write(frame.subarray(0, mid));
        await delay(3);
        res.write(frame.subarray(mid));
        if (mode === "wait") {
          res.once("close", () => closed.resolve());
          return;
        }
        if (mode === "truncated") {
          res.end();
          return;
        }
        if (mode === "stream-error") {
          res.end(`data: {"error":{"message":"${secret}"}}\n\n`);
          return;
        }
        res.end('data: {"choices":[],"usage":{"total_tokens":10}}\n\ndata: [DONE]\n\n');
      }),
    );
    const store = new SessionStore(":memory:");
    const writes = t.mock.method(store, "append");
    t.after(() => store.close());
    const providers = configureProviders({
      AGS_CUSTOM_BASE_URL: `${upstream}/v1`,
      AGS_CUSTOM_API_KEY: secret,
    });
    const base = await listen(t, createChatServer("x".repeat(32), undefined, 2500, store, providers));
    const headers = { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" };
    const call = (path: string, method: string, data?: unknown) =>
      fetch(base + path, {
        method,
        headers,
        body: data === undefined ? null : JSON.stringify(data),
      });
    const catalog = await (await call("/api/providers", "GET")).text();
    assert.ok(!catalog.includes(secret) && !catalog.includes(upstream));
    const a = await (await call("/api/sessions", "POST")).json();
    const path = `/api/sessions/${a.id}`;
    await call(path, "PATCH", { provider: "custom", model: "fixture/model" });
    const send = (message: string) => call(`${path}/chat`, "POST", { message });
    assert.match(await (await send("first")).text(), /event: done/);
    assert.match(await (await send("next")).text(), /한글/);
    const last = requests.at(-1);
    assert.equal(last?.model, "fixture/model");
    assert.deepEqual(
      last?.messages.slice(1).map((m) => m.content),
      ["first", "한글", "next"],
    );
    mode = "burst";
    writes.mock.resetCalls();
    assert.match(await (await send("burst")).text(), /event: done/);
    assert.equal(store.turns(a.id).at(-1)?.reply, "가".repeat(200));
    assert.ok(writes.mock.callCount() > 0 && writes.mock.callCount() < 20);
    for (const [failure, expected] of [
      ["401", "provider_auth"],
      ["429", "provider_limit"],
      ["503", "provider_failed"],
      ["network", "provider_failed"],
      ["truncated", "provider_failed"],
      ["stream-error", "provider_failed"],
    ]) {
      mode = failure ?? "";
      const wire = await (await send("failure")).text();
      assert.ok(!wire.includes(secret) && !wire.includes("Bearer"));
      assert.ok(wire.includes(expected ?? "") && !wire.includes("event: done"));
      assert.equal(store.turns(a.id).at(-1)?.status, "failed");
    }
    mode = "wait";
    const waiting = await send("cancel");
    const reader = waiting.body?.getReader();
    assert.ok(reader);
    await reader.read();
    assert.equal((await call(`/api/chat/${waiting.headers.get("x-request-id")}/cancel`, "POST")).status, 204);
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    assert.match(rest, /event: cancelled/);
    await closed.promise;
    assert.equal(store.turns(a.id).at(-1)?.reply, "한글");
    const timeout = await (await send("timeout")).text();
    assert.match(timeout, /"code":"timeout"/);
    assert.ok(!timeout.includes(secret));
    const b = await (await call("/api/sessions", "POST")).json();
    assert.equal(store.history(b.id).length, 0);
  },
);
test("OpenRouter 요청은 고정 호스트와 모델 ID를 쓰며 리디렉션을 차단한다", async () => {
  const providers = configureProviders({ AGS_OPENROUTER_API_KEY: secret }, async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${secret}`);
    assert.equal(options?.redirect, "error");
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const chunks = [];
  for await (const chunk of providers.stream(
    { provider: "openrouter", model: "arbitrary/model" },
    "general",
    [],
    new AbortController().signal,
  ))
    chunks.push(chunk);
  assert.deepEqual(chunks, ["ok"]);
  assert.throws(() => configureProviders({ AGS_CUSTOM_BASE_URL: "http://example.com/api" }));
});
test("이전 DB의 세션·턴은 mock으로 마이그레이션하고 설정과 과거 응답 출처를 따로 복원한다", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-migration-"));
  const file = join(dir, "sessions.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,preset TEXT);
    CREATE TABLE turns(id TEXT PRIMARY KEY,session_id TEXT,message TEXT,reply TEXT,status TEXT,preset TEXT);
    INSERT INTO sessions VALUES('a','old','general');
    INSERT INTO turns VALUES('t','a','q','a','completed','general');`);
  db.close();
  const store = new SessionStore(file);
  assert.equal(store.get("a")?.provider, "mock");
  store.setModel("a", { provider: "custom", model: "local/one" });
  store.close();
  const next = new SessionStore(file);
  try {
    assert.equal(next.get("a")?.model, "local/one");
    assert.equal(next.turns("a")[0]?.provider, "mock");
    assert.equal(next.turns("a")[0]?.reply, "a");
  } finally {
    next.close();
  }
});
