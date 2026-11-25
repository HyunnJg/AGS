import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../apps/server/src/sessions.ts";
import { assembleContext } from "../apps/server/src/context.ts";
import {
  defaultLimits,
  isLimits,
  systemPolicy,
  presetsText,
  type Message,
  defaultOrder,
  type Block,
} from "../packages/contracts/src/context.ts";

test("예산은 가장 최근의 완결된 턴부터 포함하고 지침·현재 메시지를 보존한다", () => {
  const history: Message[] = [
    { role: "user", content: "먼저" },
    { role: "assistant", content: "긴 응답".repeat(90) },
    { role: "user", content: "최근" },
    { role: "assistant", content: "짧게" },
  ];
  const prompt = "한국어",
    message = "  코드\n",
    output = 100;
  const recent = assembleContext("coding", prompt, { ...defaultLimits, turns: 1 }, history, message);
  const limited = assembleContext(
    "coding",
    prompt,
    { ...defaultLimits, inputBudget: recent.estimatedInput },
    history,
    message,
  );
  assert.deepEqual(limited.messages, recent.messages);
  assert.equal(limited.includedTurns, 1);
  assert.equal(limited.messages.at(-1)?.content, message);
  assert.deepEqual(
    limited.messages[0]?.content,
    [systemPolicy, "공용 지침\n한국어", `분야 프리셋: ${presetsText.coding}`].join("\n\n"),
  );
  const windowed = assembleContext(
    "coding",
    prompt,
    { ...defaultLimits, outputBudget: output },
    history,
    message,
    recent.estimatedInput + output,
  );
  assert.deepEqual(windowed.messages, recent.messages);
  assert.equal(
    assembleContext("coding", prompt, { ...defaultLimits, outputBudget: output }, history, message, output)
      .fits,
    false,
  );
  assert.equal(isLimits({ ...defaultLimits, turns: -1 }), false);
  assert.equal(isLimits({ ...defaultLimits, inputBudget: 0 }), false);
});

test("공용 지침과 대화별 예산은 재시작 뒤에도 복원된다", () => {
  const dir = mkdtempSync(join(tmpdir(), "ags-settings-"));
  const file = join(dir, "test.sqlite");
  let store = new SessionStore(file);
  try {
    const a = store.create(),
      b = store.create();
    const limits = { turns: 0, inputBudget: 1234, outputBudget: 333 };
    assert.ok(store.setPrompt("공용", ""));
    store.setLimits(a.id, limits);
    const order: Block[] = ["retrieval", "memory", "input", "history"];
    assert.ok(store.setPromptSettings({ prompt: "줄1\n줄2", order }, "공용", defaultOrder));
    assert.ok(!store.setPromptSettings({ prompt: "충돌", order }, "줄1\n줄2", defaultOrder));
    assert.ok(store.setSources(a.id, { memory: "A의 메모", retrieval: "A의 참고", revision: 0 }));
    assert.ok(!store.setSources(a.id, { memory: "낡은 값", retrieval: "", revision: 0 }));
    store.close();
    store = new SessionStore(file);
    assert.deepEqual(store.promptSettings(), { prompt: "줄1\n줄2", order });
    assert.equal(store.sources(a.id).memory, "A의 메모");
    assert.equal(store.sources(b.id).memory, "");
    assert.deepEqual({ ...store.limits(a.id) }, limits);
    assert.deepEqual(store.limits(b.id), defaultLimits);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("고정 지침과 안정적인 앞부분은 초안 변경에도 같고 자료는 실제 지정 위치에만 들어간다", () => {
  const sources = { memory: "지속 메모", retrieval: "검색 결과", revision: 1 };
  const order: Block[] = ["memory", "history", "input", "retrieval"];
  const make = (input: string) =>
    assembleContext("general", "줄1\n- 줄2", defaultLimits, [], input, null, order, sources);
  const a = make("첫 입력"),
    b = make("다음 입력");
  assert.deepEqual(a.messages.slice(0, 2), b.messages.slice(0, 2));
  assert.match(a.messages[0]?.content ?? "", /줄1\n- 줄2/);
  assert.deepEqual(a.blocks, ["system", "memory", "input", "retrieval"]);
  const small = assembleContext(
    "general",
    "줄1\n- 줄2",
    { ...defaultLimits, inputBudget: a.estimatedInput - 1 },
    [],
    "첫 입력",
    null,
    order,
    sources,
  );
  assert.deepEqual(small.excluded, ["retrieval"]);
  assert.equal(small.fits, true);
});

test("첨부 발췌는 예산을 넘으면 통째로 제외하고 수동 참고 자료는 유지한다", () => {
  const manual = { memory: "", retrieval: "메모", revision: 0 };
  const normal = assembleContext("general", "", defaultLimits, [], "현재", null, defaultOrder, manual);
  const limited = assembleContext(
    "general",
    "",
    { ...defaultLimits, inputBudget: normal.estimatedInput },
    [],
    "현재",
    null,
    defaultOrder,
    manual,
    [{ id: "example", project: "자료", path: "doc.txt", start: 1, end: 1, text: "긴 문장".repeat(100) }],
  );
  assert.deepEqual(limited.messages, normal.messages);
  assert.deepEqual(limited.excluded, ["retrieval"]);
});
