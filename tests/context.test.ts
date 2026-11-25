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
    [systemPolicy, '사용자의 공용 지침: "한국어"', `분야 프리셋: ${presetsText.coding}`].join("\n\n"),
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
    store.close();
    store = new SessionStore(file);
    assert.equal(store.prompt(), "공용");
    assert.deepEqual({ ...store.limits(a.id) }, limits);
    assert.deepEqual(store.limits(b.id), defaultLimits);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
