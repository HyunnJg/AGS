import assert from "node:assert/strict";
import test from "node:test";
import { configureProviders } from "../packages/providers/src/compatible.ts";
import { folderFollowupCost } from "../packages/providers/src/folder-tools.ts";

const call = { type: "function_call", call_id: "call_1", name: "list_entries", arguments: "{}" };
const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "답변" }] };
const reasoning = { type: "reasoning", summary: [], encrypted_content: "opaque" };
const signal = new AbortController().signal;

test("OpenAI 폴더 결정은 완결된 단일 함수만 허용하며 추론 항목을 예산과 후속 요청에 포함한다", async () => {
  let output: object[] = [call];
  let status = "completed";
  let usage = {};
  const providers = configureProviders({ AGS_OPENAI_API_KEY: "fixture" }, async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.equal(body.reasoning, undefined);
    assert.equal(body.max_output_tokens, 128);
    return Response.json({ status, output, usage, incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null });
  });
  const decide = (model = "gpt-6.2-sol") => providers.folderDecision({ provider: "openai", model }, [], signal, () => {}, 128);
  for (const invalid of [[call, call], [{ ...call, arguments: '{"path":"a"}' }], [{ ...call, arguments: "[]" }],
    [{ ...call, call_id: "" }], [{ ...call, status: "in_progress" }], [{ ...call, name: "read_file" }],
    [{ ...reasoning, encrypted_content: null }, call], [{ type: "web_search_call" }, call], [{ ...message, role: "system" }, call]]) {
    output = invalid;
    await assert.rejects(decide(), /provider_failed/);
  }
  status = "incomplete";
  output = [call];
  await assert.rejects(decide(), /provider_failed/);
  output = [message];
  assert.deepEqual(await decide(), { answer: "답변" });
  status = "completed";
  for (const model of ["gpt-4o", "gpt-6.2-sol"]) {
    output = model === "gpt-4o" ? [call] : [reasoning, message, call];
    usage = model === "gpt-4o" ? {} : { output_tokens: 8, output_tokens_details: { reasoning_tokens: 3 } };
    const decision = await decide(model);
    assert.ok("followup" in decision);
    assert.equal(decision.used, model === "gpt-4o" ? null : 8);
    const extra = decision.followup("{}");
    assert.ok(extra.provider === "openai");
    assert.deepEqual(extra.items, [...output, { type: "function_call_output", call_id: "call_1", output: "{}" }]);
    const cost = folderFollowupCost(extra);
    assert.equal(cost.includedMessages, extra.items.length);
    assert.ok(cost.estimatedTokens >= Buffer.byteLength(JSON.stringify(extra.items)));
  }
});

test("OpenAI 후속 스트림은 추가 도구 호출과 실패·미종료 응답을 거부한다", async () => {
  let events: object[] = [];
  const providers = configureProviders({ AGS_OPENAI_API_KEY: "fixture" }, async () => new Response(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } },
  ));
  const reply = async () => {
    const chunks: string[] = [];
    const items = [call, { type: "function_call_output", call_id: "call_1", output: "{}" }];
    for await (const chunk of providers.stream({ provider: "openai", model: "gpt-6.2-sol" }, [], signal, undefined, 20, undefined,
      { provider: "openai", items })) chunks.push(chunk);
    return chunks;
  };
  const delta = { type: "response.output_text.delta", delta: "답변" };
  const completed = { type: "response.completed", response: { status: "completed", output: [message] } };
  for (const invalid of [[delta], [{ type: "response.failed" }], [{ type: "response.output_item.added", item: call }, delta, completed],
    [{ type: "response.function_call_arguments.delta" }, completed], [{ ...completed, response: { status: "completed", output: [message, call] } }]]) {
    events = invalid;
    await assert.rejects(reply(), /provider_failed/);
  }
  events = [{ type: "response.reasoning_summary_text.delta", delta: "내부" }, delta, completed];
  assert.deepEqual(await reply(), ["답변"]);
  events = [{ type: "response.completed", response: { status: "completed", output: [
    { ...message, content: [{ type: "refusal", refusal: "거절" }] },
  ] } }];
  assert.deepEqual(await reply(), ["거절"]);
});
