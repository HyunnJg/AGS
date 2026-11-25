import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { localPort } from "../apps/server/src/port.ts";
import { createChatServer } from "../apps/server/src/server.ts";
import type { ChatEvent } from "../packages/contracts/src/chat.ts";

function events(wire: string): ChatEvent[] {
  return wire.trimEnd().split("\n\n").map(frame => {
    const [name, data = ""] = frame.split("\n");
    assert.ok(data?.startsWith("data: "));
    const event = JSON.parse(data.slice(6));
    assert.equal(name, `event: ${event.type}`);
    return event;
  });
}

async function fixture(t: TestContext, provider?: Parameters<typeof createChatServer>[1], timeoutMs?: number, totalTimeoutMs = 600_000) {
  const token = randomBytes(32).toString("hex");
  const server = createChatServer(token, provider, timeoutMs, undefined, undefined, {totalTimeoutMs});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const base = `http://${address.address}:${address.port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  function chat(message: string, signal?: AbortSignal) {
    return fetch(`${base}/api/chat`, {
      method: "POST", headers, body: JSON.stringify({ message }), signal: signal ?? null,
    });
  }
  function cancel(id: string) {
    return fetch(`${base}/api/chat/${id}/cancel`, { method: "POST", headers });
  }
  return { base, token, headers, chat, cancel };
}

test("실제 HTTP에서 한글·줄바꿈을 보존하고 done으로 한 번 종료한다", async t => {
  const { base, headers } = await fixture(t);
  const response = await fetch(`${base}/api/chat`, {
    method: "POST", headers: { ...headers, origin: base }, body: JSON.stringify({ message: "기획\n1차" }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.deepEqual(events(await response.text()), [
    { type: "delta", text: "[mock] 수신한 메시지: " }, { type: "delta", text: "기획\n1차" }, { type: "done" },
  ]);
});

test("동시 요청 중 하나만 취소하고 부분 응답과 다른 요청의 완료를 보존한다", { timeout: 8000 }, async t => {
  const release = Promise.withResolvers<void>();
  const bothStarted = Promise.withResolvers<void>();
  const cleaned = new Set<string>();
  let started = 0;
  const { chat, cancel } = await fixture(t, async function* (msg, signal) {
    try {
      yield msg;
      if (++started === 2) bothStarted.resolve();
      if (msg === "A") await delay(10_000, undefined, { signal });
      else await release.promise;
      yield "끝";
    } finally {
      cleaned.add(msg);
    }
  });
  t.after(() => release.resolve());
  const [a, b] = await Promise.all([chat("A"), chat("B")]);
  const id = a.headers.get("x-request-id");
  assert.ok(id);
  assert.notEqual(id, b.headers.get("x-request-id"));
  await bothStarted.promise;
  assert.equal((await cancel(id)).status, 204);
  assert.deepEqual(events(await a.text()), [{ type: "delta", text: "A" }, { type: "cancelled" }]);
  assert.equal((await cancel(id)).status, 404);
  assert.deepEqual([...cleaned], ["A"]);
  release.resolve();
  assert.deepEqual(events(await b.text()), [
    { type: "delta", text: "B" }, { type: "delta", text: "끝" }, { type: "done" },
  ]);
  assert.equal(cleaned.size, 2);
});

test("fetch 중단으로 연결을 끊으면 공급자와 요청 등록도 정리된다", { timeout: 8000 }, async t => {
  const finished = Promise.withResolvers<void>();
  const { chat, cancel } = await fixture(t, async function* (_, signal) {
    try {
      yield "첫 조각";
      await delay(10_000, undefined, { signal });
    } finally {
      finished.resolve();
    }
  });
  const controller = new AbortController();
  const r = await chat("중단", controller.signal);
  const id = r.headers.get("x-request-id");
  assert.ok(id);
  const reader = r.body?.getReader();
  assert.ok(reader);
  assert.equal((await reader.read()).done, false);
  controller.abort();
  await assert.rejects(reader.read());
  await finished.promise;
  assert.equal((await cancel(id)).status, 404);
});

test("공급자 예외는 비밀값 없이 error로 종료한다", async t => {
  const { chat } = await fixture(t, async function* () {
    yield "부분 응답";
    throw new Error("Authorization: Bearer PRIVATE_FIXTURE");
  });
  const r = await chat("실패");
  assert.deepEqual(events(await r.text()), [
    { type: "delta", text: "부분 응답" }, { type: "error", code: "provider_failed" },
  ]);
});

test("시간 제한에 도달하면 공급자를 중단하고 timeout 이벤트를 남긴다", async t => {
  const { chat } = await fixture(t, async function* (_, signal) {
    yield "부분";
    await delay(10_000, undefined, { signal });
  }, 50);
  assert.deepEqual(events(await (await chat("시간 제한")).text()), [
    { type: "delta", text: "부분" }, { type: "error", code: "timeout" },
  ]);
});

test("인증과 Origin 검사를 채팅과 취소 경로에 동일하게 적용한다", async t => {
  const { base, headers } = await fixture(t);
  for (const path of ["/api/chat", "/api/chat/00000000-0000-0000-0000-000000000000/cancel"]) {
    for (const authorization of ["", "Bearer incorrect"]) {
      assert.equal((await fetch(base + path, {
        method: "POST", headers: { ...headers, authorization },
      })).status, 401);
    }
    for (const origin of ["null", "https://example.com", "http://127.0.0.1:1"]) {
      assert.equal((await fetch(base + path, {
        method: "POST", headers: { ...headers, origin },
      })).status, 403);
    }
  }
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    request(`${base}/api/chat`, { method: "POST", headers: { ...headers, host: "example.com" } }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject).end();
  });
  assert.equal(badHost, 403);
});

test("잘못된 본문·메서드·경로에 구분 가능한 HTTP 오류를 반환한다", async t => {
  const { base, headers } = await fixture(t);
  const url = `${base}/api/chat`;
  for (const body of ["{", "null", "[]", "{}", '{"message":3}', '{"message":"  "}']) {
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 400);
  }
  assert.equal((await fetch(url, { method: "POST", headers, body: "한".repeat(24_000) })).status, 413);
  assert.equal((await fetch(url, { method: "POST", headers: { authorization: headers.authorization }, body: "abc" })).status, 415);
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(`${base}/missing`, { headers })).status, 404);
  assert.throws(() => createChatServer(""), /invalid_local_token/);
});

test("빈 포트 설정은 기본 포트를 사용하고 명시적인 0은 임의 포트를 선택한다", () => {
  assert.equal(localPort("   "), 4317);
  assert.equal(localPort(undefined), 4317);
  assert.equal(localPort("0"), 0);
  assert.throws(() => localPort("65536"));
});

test("로컬 Host 대소문자를 정규화하고 다른 포트의 Origin은 거부한다", async t => {
  const { base, headers } = await fixture(t);
  const host = `LOCALHOST:${new URL(base).port}`;
  async function post(origin: string) {
    return new Promise<number | undefined>((resolve, reject) => {
      request(`${base}/api/chat`, {
        method: "POST", headers: { ...headers, host, origin },
      }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject).end(JSON.stringify({ message: "확인" }));
    });
  }
  assert.equal(await post(`http://${host.toLowerCase()}`), 200);
  assert.equal(await post("http://localhost:1"), 403);
});

test("응답이 계속 오면 유휴 타이머가 연장되고 전체 상한은 유지된다",async t=>{
  const provider: NonNullable<Parameters<typeof createChatServer>[1]> = async function* (_,signal){
    for(let i=0;i<8;i++){await delay(40,undefined,{signal});yield "계속";}
  };
  const active=await fixture(t,provider,200);
  assert.equal(events(await (await active.chat("계속")).text()).at(-1)?.type,"done");
  const capped=await fixture(t,provider,200,180);
  assert.deepEqual(events(await (await capped.chat("상한")).text()).at(-1),{type:"error",code:"timeout"});
});
