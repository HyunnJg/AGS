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
    const requests: { model: string; max_tokens?: number; messages: { role: string; content: string }[] }[] =
      [];
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
          res
            .writeHead(Number(mode), {
              "set-cookie": "sid=private-cookie",
              "x-request-id": "fixture-request",
            })
            .end(JSON.stringify({ message: secret, error: "fixture-error" }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (mode === "burst") {
          res.write('data: {"choices":[{"delta":{"content":"가"}}]}\n\n'.repeat(200));
          res.write(`: ${"x".repeat(65536)}\n\n`);
          res.end('data: {"choices":[],"usage":{"total_tokens":250}}\n\ndata: [DONE]\n\n');
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
    const checkSummary = () => {
      const sent = requests.at(-1);
      assert.ok(sent);
      assert.deepEqual(store.callDetails()[0]?.request, {
        messageCount: sent.messages.length,
        contentBytes: sent.messages.reduce((total, m) => total + Buffer.byteLength(m.content), 0),
        maxTokens: sent.max_tokens ?? null,
      });
      const row = store.callList()[0] ?? {};
      assert.ok(!("request" in row) && !("contextBudget" in row));
    };
    checkSummary();
    const displayPath = "/api/settings/display-rules";
    const rule = {
      id: "label",
      name: "표시",
      pattern: "한글",
      flags: "g",
      replacement: "화면용",
      enabled: true,
    };
    const update = { revision: 0, rules: [rule] };
    assert.deepEqual(await (await call(displayPath, "GET")).json(), {
      revision: 0,
      rules: [],
    });
    assert.equal((await call(displayPath, "PUT", update)).status, 200);
    assert.equal((await call(displayPath, "PUT", update)).status, 409);
    assert.equal((await call(displayPath, "PUT", { revision: 1, rules: [rule, rule] })).status, 400);
    assert.deepEqual(await (await call(displayPath, "GET")).json(), {
      revision: 1,
      rules: [rule],
    });
    assert.match(await (await send("next")).text(), /한글/);
    const last = requests.at(-1);
    assert.equal(last?.model, "fixture/model");
    assert.deepEqual(
      last?.messages.slice(1).map((m) => m.content),
      ["first", "한글", "next"],
    );
    const limits = { turns: 1, inputBudget: 4000, outputBudget: 128 };
    assert.equal((await call(`${path}/context`, "PUT", limits)).status, 200);
    await call("/api/settings/prompt", "PUT", { prompt: "한글로 작성", previous: "" });
    assert.equal(
      (await call("/api/settings/prompt", "PUT", { prompt: "오래된 편집", previous: "" })).status,
      409,
    );
    const sourceData = { memory: "유지할 메모", retrieval: "검토 자료", revision: 0 };
    assert.equal((await call(`${path}/sources`, "PUT", sourceData)).status, 200);
    assert.equal((await call(`${path}/sources`, "PUT", sourceData)).status, 409);
    const currentPrompt = await (await call("/api/settings/prompt", "GET")).json();
    const newOrder = ["input", "retrieval", "history", "memory"];
    assert.equal(
      (
        await call("/api/settings/prompt", "PUT", {
          prompt: currentPrompt.prompt,
          previous: currentPrompt.prompt,
          previousOrder: currentPrompt.order,
          order: ["input", "input", "history", "memory"],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("/api/settings/prompt", "PUT", {
          prompt: currentPrompt.prompt,
          previous: currentPrompt.prompt,
          previousOrder: currentPrompt.order,
          order: newOrder,
        })
      ).status,
      200,
    );
    const projectId = store.addProject("참고 문서");
    const ref = store.addReference(a.id, projectId, "notes.md", "a".repeat(64), 2, 2, "선택한 줄");
    assert.ok(ref);
    const knowledge = store.addReference(a.id, projectId, "guide.md", "b".repeat(64), 1, 1, "방법론", "knowledge");
    assert.ok(knowledge);
    assert.equal((await call("/api/settings/knowledge", "PUT", { enabled: false })).status, 200);
    const langPath = "/api/settings/response-language";
    assert.deepEqual(await (await call(langPath, "GET")).json(), {language: "auto"});
    assert.equal((await call(langPath, "PUT", {language: "other", previous: "auto"})).status, 400);
    assert.equal((await call(langPath, "PUT", {language: "ja", previous: "auto"})).status, 200);
    assert.equal((await call(langPath, "PUT", {language: "ko", previous: "auto"})).status, 409);
    const presetsPath = "/api/settings/presets";
    const definition = { name: "사료 검토", instructions: "Distinguish evidence from inference." };
    const registered = await (await call(presetsPath, "POST", definition)).json();
    assert.deepEqual(await (await call(presetsPath, "POST", definition)).json(), registered);
    assert.deepEqual(await (await call(presetsPath, "GET")).json(), [{id: registered.id, name: definition.name}]);
    assert.equal((await call(presetsPath, "POST", {...definition, instructions:" "})).status, 400);
    assert.equal((await call(presetsPath, "POST", {...definition, instructions:"new"})).status, 409);
    assert.equal((await call(path, "PATCH", {preset: "custom-00000000-0000-0000-0000-000000000000"})).status, 404);
    assert.equal((await call(path, "PATCH", {preset: registered.id})).status, 200);
    const callsBefore = requests.length;
    const preview = await (await call(`${path}/context-preview`, "POST", { message: "다음", limits })).json();
    assert.equal(requests.length, callsBefore);
    assert.equal(preview.includedTurns, 1);
    assert.deepEqual(
      preview.messages.slice(1).map((m: { content: string }) => m.content),
      [
        "다음",
        "검색·임베딩 자료 (참고 자료)\n검토 자료",
        "첨부 파일 (참고 자료) · 참고 문서 / notes.md · 2–2줄\n선택한 줄",
        "next",
        "한글",
        "장기기억 (참고 자료)\n유지할 메모",
      ],
    );
    assert.match(preview.messages[0].content, /한글로 작성/);
    assert.match(preview.messages[0].content, /일본어로 답하세요/);
    assert.ok(preview.messages[0].content.includes(definition.instructions));
    assert.match(await (await send("다음")).text(), /event: done/);
    assert.deepEqual(requests.at(-1)?.messages, preview.messages);
    assert.equal(requests.at(-1)?.max_tokens, 128);
    checkSummary();
    assert.equal((await call("/api/settings/knowledge", "PUT", { enabled: true })).status, 200);
    const withKnowledge = await (await call(`${path}/context-preview`, "POST", { message: "방법 확인", limits })).json();
    assert.ok(withKnowledge.messages.some((m: {content: string}) => m.content === "지식 발췌 (참고 자료) · 참고 문서 / guide.md · 1–1줄\n방법론"));
    assert.match(await (await send("방법 확인")).text(), /event: done/);
    assert.deepEqual(requests.at(-1)?.messages, withKnowledge.messages);
    store.removeReference(a.id, knowledge);
    store.removeReference(a.id, ref);
    const requiredOnly = {
      ...limits,
      inputBudget: Buffer.byteLength(preview.messages[0].content) + Buffer.byteLength("다음") + 16,
    };
    await call(`${path}/context`, "PUT", requiredOnly);
    const trimmed = await (await call(`${path}/context-preview`, "POST", { message: "다음", limits: requiredOnly })).json();
    assert.match(await (await send("다음")).text(), /event: done/);
    assert.deepEqual(requests.at(-1)?.messages, trimmed.messages);
    const trimmedId = store.callList()[0]?.id;
    const expectedBudget = {
      estimatedInput: trimmed.estimatedInput,
      inputCeiling: requiredOnly.inputBudget,
      blockUsage: trimmed.blockUsage,
    };
    assert.ok(expectedBudget.blockUsage.some((row: { omittedMessages: number }) => row.omittedMessages > 0));
    const countBeforeRejection = store.callList().length;
    const before = store.turns(a.id).length;
    await call(`${path}/context`, "PUT", { ...limits, inputBudget: 1 });
    assert.equal((await send("큰 입력")).status, 422);
    assert.equal(requests.length, callsBefore + 3);
    assert.equal(store.callList().length, countBeforeRejection);
    assert.equal(store.turns(a.id).length, before);
    await call(`${path}/context`, "PUT", limits);
    mode = "burst";
    writes.mock.resetCalls();
    assert.match(await (await send("burst")).text(), /event: done/);
    assert.equal(store.turns(a.id).at(-1)?.reply, "가".repeat(200));
    const burst = store.callDetails()[0];
    assert.ok(burst?.bodyLimited && !burst.body.includes("total_tokens"));
    assert.deepEqual(burst.usage, {totalTokens: 250});
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
      checkSummary();
    }
    const exported = await (await call("/api/call-logs/export", "GET")).json();
    assert.ok(
      !JSON.stringify(exported).includes(secret) && !JSON.stringify(exported).includes("private-cookie"),
    );
    assert.deepEqual(exported.find((row: { id: string }) => row.id === trimmedId).contextBudget, expectedBudget);
    const authFailure = exported.find((log: { httpStatus: number }) => log.httpStatus === 401);
    assert.equal(authFailure.headers["set-cookie"], "[가림]");
    assert.equal(authFailure.headers["x-request-id"], "fixture-request");
    assert.equal(JSON.parse(authFailure.body).error, "fixture-error");
    assert.equal(authFailure.answer, "");
    assert.equal(authFailure.contextBudget.inputCeiling, limits.inputBudget);
    assert.ok(
      exported.some(
        (log: { body: string; answer: string; status: string }) =>
          log.body.includes(": keepalive") &&
          log.body.includes("total_tokens") &&
          log.answer === "한글" &&
          log.status === "completed",
      ),
    );
    assert.ok(
      exported.some(
        (log: { body: string; answer: string; status: string }) =>
          log.body.includes(": keepalive") &&
          !log.body.includes("[DONE]") &&
          log.answer === "한글" &&
          log.status === "failed",
      ),
    );
    assert.equal((await fetch(`${base}/api/call-logs/export`)).status, 401);
    mode = "wait";
    const waiting = await send("cancel");
    assert.equal((await call(path, "PATCH", { provider: "mock", model: "" })).status, 409);
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
    const [timedOut, cancelled] = store.callDetails();
    assert.equal(timedOut?.status, "timeout");
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.answer, "한글");
    assert.equal((await call(langPath, "PUT", {language: "auto", previous: "ja"})).status, 200);
    const automatic = await (await call(`${path}/context-preview`, "POST", {message: "자동", limits})).json();
    assert.doesNotMatch(automatic.messages[0].content, /사용자가 다른 언어/);
    const logsPath = "/api/call-logs";
    const count = store.callList().length;
    const turns = store.turns(a.id);
    assert.equal((await fetch(base + logsPath, { method: "DELETE" })).status, 401);
    assert.equal((await fetch(base + logsPath, { method: "DELETE", headers: { ...headers, origin: "https://example.org" } })).status, 403);
    for (const suffix of ["/export", `/${authFailure.id}`])
      assert.equal((await call(logsPath + suffix, "DELETE")).status, 405);
    assert.deepEqual(await (await call(logsPath, "DELETE")).json(), { deleted: count });
    assert.deepEqual(await (await call(logsPath, "DELETE")).json(), { deleted: 0 });
    assert.equal((await call(`${logsPath}/${authFailure.id}`, "GET")).status, 404);
    assert.deepEqual(await (await call(`${logsPath}/export`, "GET")).json(), []);
    assert.deepEqual(store.turns(a.id), turns);
    const b = await (await call("/api/sessions", "POST")).json();
    assert.equal(store.history(b.id).length, 0);
    assert.deepEqual(await (await call(`/api/sessions/${b.id}/context`, "GET")).json(), {
      turns: 12,
      inputBudget: null,
      outputBudget: null,
    });
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

test("모델 목록은 공급자별로 정규화하고 동시·반복 조회를 공유한다", async () => {
  let calls = 0;
  const providers = configureProviders(
    { AGS_CUSTOM_BASE_URL: "http://127.0.0.1:4000/api/v1", AGS_CUSTOM_API_KEY: secret },
    async (url, init) => {
      calls++;
      assert.equal(url, "http://127.0.0.1:4000/api/v1/models");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
      return Response.json({
        data: [
          { id: "test/model", name: "Fixture", context_length: 8192, other: secret },
          { id: "test/model" },
          { id: " x" },
          { id: secret },
        ],
      });
    },
  );
  const expected = [{ id: "test/model", name: "Fixture", contextLength: 8192 }];
  const [a, b] = await Promise.all([providers.models("custom"), providers.models("custom")]);
  assert.deepEqual(a, expected);
  assert.deepEqual(b, expected);
  assert.deepEqual(await providers.models("custom"), expected);
  assert.equal(calls, 1);
  assert.equal(providers.contextWindow("custom", "test/model"), 8192);
  await Promise.all([providers.models("custom", true), providers.models("custom", true)]);
  assert.equal(calls, 2);
});

test("목록 조회 실패 후에도 모델 ID 직접 적용과 즐겨찾기 저장이 된다", async (t) => {
  const store = new SessionStore(":memory:");
  t.after(() => store.close());
  const providers = configureProviders(
    { AGS_CUSTOM_BASE_URL: "http://localhost:1234/v1" },
    async () => new Response(secret, { status: 404 }),
  );
  const token = "x".repeat(32);
  const base = await listen(t, createChatServer(token, undefined, undefined, store, providers));
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const path = `${base}/api/providers/custom/models`;
  assert.equal((await fetch(path)).status, 401);
  const response = await fetch(path, { headers });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(secret));
  const selection = { provider: "custom", model: "my/manual-model" };
  const session = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify(selection),
  });
  assert.equal((await session.json()).model, selection.model);
  const pins = `${base}/api/settings/favorites`;
  for (const pinned of [true, true, false]) {
    const r = await fetch(pins, { method: "PUT", headers, body: JSON.stringify({ ...selection, pinned }) });
    assert.deepEqual(await r.json(), pinned ? [selection] : []);
  }
});

test("저장 장치가 계속 실패해도 SSE 오류 이벤트로 한 번 종료한다", async (t) => {
  const store = new SessionStore(":memory:");
  t.after(() => store.close());
  const session = store.create();
  t.mock.method(store, "append", () => {
    throw new Error(secret);
  });
  t.mock.method(store, "finish", () => {
    throw new Error(secret);
  });
  const base = await listen(
    t,
    createChatServer(
      "x".repeat(32),
      async function* (_, signal) {
        yield "조각";
        await delay(1200, undefined, { signal });
      },
      2000,
      store,
    ),
  );
  const res = await fetch(`${base}/api/sessions/${session.id}/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" },
    body: JSON.stringify({ message: "저장" }),
  });
  const wire = await res.text();
  assert.match(wire, /"code":"storage_failed"/);
  assert.equal(wire.match(/event: error/g)?.length, 1);
  assert.ok(!wire.includes(secret));
});

test("OpenAI 직접 연결은 고정 주소·전용 키·출력 한도를 사용하고 오류 본문을 마스킹한다", async (t) => {
  const db = new SessionStore(":memory:");
  t.after(() => db.close());
  const env = {
    AGS_OPENAI_API_KEY: "direct-test-key",
    AGS_OPENROUTER_API_KEY: "router-test-key",
    AGS_CUSTOM_API_KEY: "custom-test-key",
    AGS_CUSTOM_BASE_URL: "http://localhost/v1",
  };
  let status = 200;
  const adapters = configureProviders(env, async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/chat/completions");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.AGS_OPENAI_API_KEY}`);
    const request = JSON.parse(String(init?.body));
    assert.equal(request.max_completion_tokens, 123);
    assert.equal(request.max_tokens, undefined);
    if (status !== 200) return Response.json({ error: { message: Object.values(env).join(" ") } }, { status });
    return new Response('data: {"choices":[{"delta":{"refusal":"검토 결과"}}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const target = { provider: "openai" as const, model: "fixture" };
  const run = async () => {
    const capture = db.startCall("chat", target, null);
    try {
      let result = "";
      for await (const text of adapters.stream(target, [{ role: "user", content: "안녕" }],
        new AbortController().signal, undefined, 123, capture)) {
        capture?.answer(text);
        result += text;
      }
      capture?.finish("completed");
      return result;
    } catch (error) {
      capture?.finish("failed");
      throw error;
    }
  };
  assert.equal(await run(), "검토 결과");
  for (const [code, failure] of [[401, /provider_auth/], [429, /provider_limit/], [503, /provider_failed/]] as const) {
    status = code;
    await assert.rejects(run(), failure);
    const entry = db.callDetails()[0];
    assert.equal(entry?.httpStatus, code);
    assert.equal(entry?.status, "failed");
    for (const key of [env.AGS_OPENAI_API_KEY, env.AGS_OPENROUTER_API_KEY, env.AGS_CUSTOM_API_KEY])
      assert.ok(!entry?.body.includes(key));
  }
  let calls = 0;
  const noKey = configureProviders({ AGS_OPENROUTER_API_KEY: "router-only" }, async () => {
    calls++;
    throw new Error("unexpected request");
  });
  await assert.rejects(noKey.models("openai"), /provider_unavailable/);
  await assert.rejects(noKey.stream(target, [], new AbortController().signal).next(), /provider_failed/);
  assert.equal(calls, 0);
});

test("새 대화의 기본 공급자는 설정된 OpenRouter, OpenAI, Gemini, Anthropic, mock 순서다", async (t) => {
  const token = "x".repeat(32);
  const env = { AGS_OPENAI_API_KEY: "fixture", AGS_OPENAI_MODEL: "direct" };
  for (const [settings, expected] of [
    [{ ...env, AGS_OPENROUTER_API_KEY: "fixture-2", AGS_OPENROUTER_MODEL: "router" }, ["openrouter", "router"]],
    [{...env, AGS_GEMINI_API_KEY:"fixture-3", AGS_GEMINI_MODEL:"google"}, ["openai", "direct"]],
    [{AGS_GEMINI_API_KEY:"fixture-3", AGS_GEMINI_MODEL:"google", AGS_ANTHROPIC_API_KEY:"fixture-4", AGS_ANTHROPIC_MODEL:"claude"}, ["gemini", "google"]],
    [{AGS_ANTHROPIC_API_KEY:"fixture-4", AGS_ANTHROPIC_MODEL:"claude"}, ["anthropic", "claude"]],
    [{ ...env, AGS_OPENAI_API_KEY: "" }, ["mock", ""]],
  ] as const) {
    const store = new SessionStore(":memory:");
    t.after(() => store.close());
    const base = await listen(t, createChatServer(token, undefined, 2500, store, configureProviders(settings)));
    const res = await fetch(`${base}/api/sessions`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 201);
    const session = await res.json();
    assert.deepEqual([session.provider, session.model], expected);
  }
});
