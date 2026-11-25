import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mockReply } from "../packages/providers/src/mock.ts";

const entry = fileURLToPath(new URL("../scripts/mock.ts", import.meta.url));

test("두 요청의 응답은 독립적이며 입력 순서대로 조각을 반환한다", () => {
  const first = mockReply(" 첫 요청 ");
  const second = mockReply("두 번째 요청");
  assert.equal(first.next().value, "[mock] 수신한 메시지: ");
  assert.deepEqual([...second], ["[mock] 수신한 메시지: ", "두 번째 요청"]);
  assert.deepEqual([...first], ["첫 요청"]);
});

test("기본 실행은 키 없이 예제 응답을 출력한다", () => {
  const result = spawnSync(process.execPath, [entry], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trimEnd(), "[mock] 수신한 메시지: AGS 연결 확인");
});

test("명령행으로 전달한 한글과 줄바꿈을 보존한다", () => {
  const result = spawnSync(process.execPath, [entry, "기획", "1차\n메모"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trimEnd(), "[mock] 수신한 메시지: 기획 1차\n메모");
});

test("공백뿐인 메시지는 오류로 종료한다", () => {
  const result = spawnSync(process.execPath, [entry, "   "], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /메시지를 입력/);
});
