import assert from "node:assert/strict";
import test from "node:test";
import type { CallLog } from "../packages/contracts/src/calls.ts";
import type { Message } from "../packages/contracts/src/context.ts";
import { isModelSelection } from "../packages/contracts/src/providers.ts";
import { configureProviders } from "../packages/providers/src/compatible.ts";
import { CallCapture } from "../packages/providers/src/capture.ts";

const target = { provider: "gemini", model: "test-model.1" } as const;
const env = { AGS_GEMINI_API_KEY: "fixture-google-key", AGS_OPENAI_API_KEY: "fixture-openai-key" };
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;
const finalFrame = frame({ candidates: [{ finishReason: "STOP" }], usageMetadata: { totalTokenCount: 42 } });
const textFrame = frame({
  candidates: [{ content: { parts: [{ thought: true, text: "생각" }, { text: "답변" }] } }],
});

test("Gemini 전송은 지침과 역할·파트 순서를 보존하고 표시할 답변만 복원한다", async () => {
  const messages: Message[] = [
    { role: "system", content: "규칙" },
    { role: "user", content: "기억" },
    { role: "user", content: "과거 입력" },
    { role: "assistant", content: "과거 출력" },
    { role: "user", content: "현재 입력" },
  ];
  let status = 200;
  let wire =
    frame({
      promptFeedback: { blockReason: "BLOCK_REASON_UNSPECIFIED" },
      candidates: [{ finishReason: "FINISH_REASON_UNSPECIFIED" }],
    }) +
    textFrame +
    finalFrame + frame({ usageMetadata: {
      promptTokenCount: 18, cachedContentTokenCount: 0, candidatesTokenCount: 12,
      thoughtsTokenCount: 9, toolUsePromptTokenCount: 3, totalTokenCount: "bad", other: "ignore",
    } });
  const adapters = configureProviders(env, async (url, init) => {
    assert.equal(
      url,
      "https://generativelanguage.googleapis.com/v1beta/models/test-model.1:streamGenerateContent?alt=sse",
    );
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-goog-api-key"), env.AGS_GEMINI_API_KEY);
    assert.equal(headers.get("authorization"), null);
    assert.equal(init?.redirect, "error");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      systemInstruction: { parts: [{ text: "규칙" }] },
      contents: [
        { role: "user", parts: [{ text: "기억" }, { text: "과거 입력" }] },
        { role: "model", parts: [{ text: "과거 출력" }] },
        { role: "user", parts: [{ text: "현재 입력" }] },
      ],
      generationConfig: { maxOutputTokens: 100 },
    });
    if (status !== 200)
      return Response.json({ error: env.AGS_GEMINI_API_KEY, "x-goog-api-key": "redact-also" }, { status });
    const bytes = Buffer.from(wire);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 5) controller.enqueue(bytes.subarray(i, i + 5));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const logs: CallLog[] = [];
  const run = async () => {
    const capture = new CallCapture("chat", target, null, (row) => logs.push(row));
    try {
      for await (const part of adapters.stream(
        target,
        messages,
        new AbortController().signal,
        undefined,
        100,
        capture,
      ))
        capture.answer(part);
      capture.finish("completed");
    } catch (error) {
      capture.finish("failed");
      throw error;
    }
  };
  await run();
  assert.equal(logs[0]?.answer, "답변");
  assert.deepEqual(logs[0]?.usage, {
    inputTokens: 18, cachedInputTokens: 0, candidateTokens: 12, reasoningTokens: 9,
    toolPromptTokens: 3, totalTokens: 42,
  });
  assert.ok(logs[0]?.body.includes("usageMetadata"));
  assert.equal(logs[0]?.request?.messageCount, messages.length);
  for (const bad of [
    textFrame,
    frame({ promptFeedback: { blockReason: "SAFETY" } }),
    textFrame + frame({ error: { code: 500 } }),
    frame({ candidates: [{ finishReason: "SAFETY" }] }),
  ]) {
    wire = bad;
    await assert.rejects(run(), /provider_failed/);
    assert.equal(logs.at(-1)?.status, "failed");
  }
  wire = textFrame + frame({ candidates: [{ finishReason: "MAX_TOKENS" }],
    usageMetadata: { promptTokenCount: -1, thoughtsTokenCount: 0.5, totalTokenCount: 2 ** 53 } });
  await run();
  assert.equal(logs.at(-1)?.usage, undefined);
  for (const [code, error] of [
    [403, /provider_auth/],
    [429, /provider_limit/],
    [503, /provider_failed/],
  ] as const) {
    status = code;
    await assert.rejects(run(), error);
    assert.equal(logs.at(-1)?.httpStatus, code);
    assert.doesNotMatch(logs.at(-1)?.body ?? "", /fixture-google-key|redact-also/);
  }
  assert.ok(!isModelSelection({ ...target, model: "../models/x" }));
  let called = false;
  const disabled = configureProviders({ AGS_OPENAI_API_KEY: "openai-only" }, async () => {
    called = true;
    throw new Error();
  });
  await assert.rejects(
    disabled.stream(target, messages, new AbortController().signal).next(),
    /provider_failed/,
  );
  assert.equal(called, false);
});

test("Gemini 모델 목록은 생성 모델만 모으고 페이지별로 기록하며 잘못된 커서를 거부한다", async () => {
  const logs: CallLog[] = [];
  let repeat = false,
    calls = 0;
  const adapters = configureProviders(env, async (path, init) => {
    const url = new URL(String(path));
    calls++;
    assert.equal(url.origin + url.pathname, "https://generativelanguage.googleapis.com/v1beta/models");
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), env.AGS_GEMINI_API_KEY);
    const next = url.searchParams.get("pageToken");
    if (!next)
      return Response.json({
        models: [
          { name: "models/good", displayName: "A", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
        ],
        nextPageToken: "next +/%",
      });
    assert.equal(next, "next +/%");
    return Response.json({
      models: [{ name: "models/second", supportedGenerationMethods: ["generateContent"] }],
      ...(repeat && { nextPageToken: next }),
    });
  });
  const make = () => new CallCapture("catalog", { ...target, model: "" }, null, (row) => logs.push(row));
  const items = await adapters.models("gemini", false, make);
  assert.deepEqual(
    items.map((r) => r.id),
    ["good", "second"],
  );
  assert.equal(logs.length, 2);
  assert.deepEqual(await adapters.models("gemini", false, make), items);
  assert.equal(calls, 2);
  repeat = true;
  await assert.rejects(adapters.models("gemini", true, make), /invalid_catalog_cursor/);
  assert.equal(logs.at(-1)?.status, "failed");
  assert.deepEqual(await adapters.models("gemini"), items);
});

test("Gemini 스트리밍 중 중단하면 이미 받은 텍스트만 남고 재요청하지 않는다", async () => {
  const controller = new AbortController();
  let count = 0;
  const adapters = configureProviders(env, async (_url, init) => {
    count++;
    return new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(Buffer.from(textFrame));
          init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), { once: true });
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const stream = adapters.stream(target, [{ role: "user", content: "질문" }], controller.signal);
  assert.equal((await stream.next()).value, "답변");
  const reason = new Error("사용자 중단");
  controller.abort(reason);
  await assert.rejects(stream.next(), (error) => error === reason);
  assert.equal(count, 1);
});

test("Gemini의 400 응답은 구조화된 키 오류만 인증 오류로 분류한다", async () => {
  for (const [reason, expected] of [
    ["API_KEY_INVALID", /provider_auth/],
    ["BAD_REQUEST", /provider_failed/],
  ] as const) {
    const adapters = configureProviders(env, async () =>
      Response.json({ error: { message: "API_KEY_INVALID", details: [{ reason }] } }, { status: 400 }),
    );
    await assert.rejects(
      adapters.stream(target, [{ role: "user", content: "질문" }], new AbortController().signal).next(),
      expected,
    );
    await assert.rejects(adapters.models("gemini"), expected);
  }
});
