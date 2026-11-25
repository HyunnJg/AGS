import test from "node:test";
import assert from "node:assert/strict";
import { transformReply } from "../apps/web/src/displayTransform.ts";
import { ruleError, maxText, type DisplayRule } from "../packages/contracts/src/display.ts";

const first: DisplayRule = {
  id: "one",
  name: "첫 규칙",
  pattern: "(cat)",
  flags: "gi",
  replacement: "[$1]",
  enabled: true,
};
test("표시 규칙은 순서, 사용 여부, 캡처와 유니코드 빈 일치를 처리한다", () => {
  const second = {
    ...first,
    id: "two",
    pattern: "\\[cat\\]",
    replacement: "본문",
  };
  assert.equal(transformReply("CAT cat", [first, second]), "본문 본문");
  assert.equal(transformReply("CAT cat", [second, first]), "[CAT] [cat]");
  assert.equal(transformReply("cat", [{ ...first, enabled: false }]), "cat");
  assert.equal(
    transformReply("cat cat", [{ ...first, flags: "", replacement: "$$ $& $1" }]),
    "$ cat cat cat",
  );
  assert.equal(transformReply("🐈", [{ ...first, pattern: "(?:)", flags: "gu", replacement: "." }]), ".🐈.");
});
test("규칙 저장과 치환에는 각 단계에 맞는 한도가 있다", () => {
  assert.equal(ruleError([first]), "");
  for (const invalid of [
    [first, first],
    [{ ...first, flags: "gg" }],
    [{ ...first, pattern: "[" }],
    [{ ...first, flags: "x" }],
  ])
    assert.ok(ruleError(invalid));
  assert.throws(() => transformReply("가".repeat(maxText + 1), [first]), /텍스트 길이/);
  assert.throws(() => transformReply("a".repeat(4097), [{ ...first, pattern: "a" }]), /횟수/);
  assert.throws(
    () => transformReply("a".repeat(200), [{ ...first, pattern: "a", replacement: "b".repeat(512) }]),
    /결과가 길이/,
  );
});
