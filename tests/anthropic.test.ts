import assert from "node:assert/strict";
import test from "node:test";
import { configureProviders } from "../packages/providers/src/compatible.ts";
import { CallCapture } from "../packages/providers/src/capture.ts";
import type { CallLog } from "../packages/contracts/src/calls.ts";

const env = { AGS_ANTHROPIC_API_KEY: "claude-fixture-key", AGS_OPENAI_API_KEY: "fixture-other-key" };
const target = { provider: "anthropic", model: "fixture-model" } as const;
const complete = [
  { type: "message_start", message: { usage: {
    input_tokens: 8, cache_read_input_tokens: 48, cache_creation_input_tokens: 0, output_tokens: 1,
  } } },
  { type: "ping" },
  { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "internal" } },
  { type: "content_block_delta", delta: { type: "text_delta", text: "본문" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
  { type: "message_stop" },
];
test("Claude는 전용 키·버전·출력 예산을 보내고 완결된 텍스트와 부분 실패를 구분한다", async () => {
  let events = complete,
    status = 200;
  const logs: CallLog[] = [];
  let budget: number | undefined;
  const api = configureProviders(env, async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("anthropic-version"), "2026-10-21");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.AGS_ANTHROPIC_API_KEY}`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: target.model,
      system: [{ type: "text", text: "규칙" }],
      stream: true,
      max_tokens: budget ?? 4096,
      messages: [
        { role: "user", content: "지난 질문" },
        { role: "assistant", content: "응답" },
        { role: "user", content: "새 요청" },
      ],
    });
    if (status !== 200)
      return Response.json({ error: { message: Object.values(env).join(" ") } }, { status });
    const bytes = Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
    return new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.subarray(i, i + 3));
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const run = async () => {
    const capture = new CallCapture("chat", target, null, (row) => logs.push(row));
    try {
      for await (const part of api.stream(
        target,
        [
          { role: "system", content: "규칙" },
          { role: "user", content: "지난 질문" },
          { role: "assistant", content: "응답" },
          { role: "user", content: "새 요청" },
        ],
        new AbortController().signal,
        undefined,
        budget,
        capture,
      ))
        capture.answer(part);
      capture.finish("completed");
    } catch (e) {
      capture.finish("failed");
      throw e;
    }
  };
  await run();
  assert.equal(logs.at(-1)?.answer, "본문");
  assert.equal(logs.at(-1)?.request?.maxTokens, 4096);
  assert.deepEqual(logs.at(-1)?.usage, {
    uncachedInputTokens: 8, cachedInputTokens: 48, cacheWriteTokens: 0, outputTokens: 4,
  });
  budget = 1200;
  for (const suffix of [[], [{ type: "error" }]]) {
    events = [...complete.slice(0, 4), ...suffix];
    await assert.rejects(run(), /provider_failed/);
    assert.equal(logs.at(-1)?.answer, "본문");
    assert.equal(logs.at(-1)?.status, "failed");
    assert.equal(logs.at(-1)?.usage?.outputTokens, 1);
  }
  for (const [code, expected] of [
    [401, /provider_auth/],
    [429, /provider_limit/],
    [529, /provider_failed/],
  ] as const) {
    status = code;
    await assert.rejects(run(), expected);
    assert.doesNotMatch(logs.at(-1)?.body ?? "", /fixture-key|other-key/);
  }
});

test("Claude 모델 페이지는 이름·다음 커서를 해석하고 완결된 목록만 캐시한다", async () => {
  let requests = 0,
    invalid = false;
  const api = configureProviders(env, async (path, init) => {
    const url = new URL(String(path));
    assert.equal(url.origin + url.pathname, "https://api.anthropic.com/v1/models");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.AGS_ANTHROPIC_API_KEY}`);
    requests++;
    const after = url.searchParams.get("after_id");
    if (!after)
      return Response.json({ data: [{ id: "a", display_name: "A" }], has_more: true, last_id: "a" });
    assert.equal(after, "a");
    return Response.json({
      data: [{ id: "b", display_name: "B" }],
      has_more: invalid,
      last_id: invalid ? "a" : "b",
    });
  });
  const models = await api.models("anthropic");
  assert.deepEqual(models, [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ]);
  assert.deepEqual(await api.models("anthropic"), models);
  assert.equal(requests, 2);
  invalid = true;
  await assert.rejects(api.models("anthropic", true), /invalid_catalog_cursor/);
  assert.deepEqual(await api.models("anthropic"), models);
});

test("Claude 폴더 조회는 단일 빈 인자 호출만 수락하고 결과 전송 뒤의 추가 도구를 거부한다", async () => {
  const call = { type: "tool_use", id: "toolu_fixture", name: "list_entries", input: {} };
  let content: object[] = [call];
  const api = configureProviders(env, async (_url, init) => {
    if (!JSON.parse(String(init?.body)).stream)
      return Response.json({ type: "message", role: "assistant", content, stop_reason: "tool_use", usage: { output_tokens: 4 } });
    const events = [complete[0], { type: "content_block_start", content_block: call }, ...complete.slice(2)];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  const signal = new AbortController().signal;
  const decide = () => api.folderDecision(target, [{ role: "user", content: "목록" }], signal, () => {}, 100);
  for (const invalid of [[call, { ...call, id: "second" }], [{ ...call, input: { path: "notes" } }],
    [{ ...call, input: [] }], [{ ...call, id: "" }], [{ type: "text", text: "호출 누락" }]]) {
    content = invalid;
    await assert.rejects(decide(), /provider_failed/);
  }
  content = [call];
  const decision = await decide();
  assert.ok("followup" in decision);
  await assert.rejects(async () => {
    for await (const _ of api.stream(target, [], signal, () => {}, 96, undefined, decision.followup("{}"))) {
      assert.fail("추가 도구 요청 뒤에 텍스트가 표시됐습니다.");
    }
  }, /provider_failed/);
});
