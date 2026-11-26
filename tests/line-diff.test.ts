import assert from "node:assert/strict";
import test from "node:test";
import { lineDiff } from "../apps/web/src/line-diff.ts";

test("반복 줄이 있는 긴 문서에서도 삽입·삭제 위치를 양쪽 줄 번호로 구분한다", () => {
  const middle = Array<string>(12_000).fill("같은 본문");
  const before = [...middle, "삭제", "끝"];
  const after = ["추가", ...middle, "끝"];
  assert.deepEqual(lineDiff(before, after), {
    grouped: false,
    changes: [
      { oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 1 },
      { oldStart: 12_000, oldEnd: 12_001, newStart: 12_001, newEnd: 12_001 },
    ],
  });
  assert.deepEqual(lineDiff([], []).changes, []);
  assert.deepEqual(lineDiff(["", "a"], ["", "a"]).changes, []);
  assert.deepEqual(lineDiff([], ["", "a"]).changes, [{ oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 2 }]);
  assert.deepEqual(lineDiff(["a"], []).changes, [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 0 }]);
});

test("전체를 바꾼 문서는 비교 예산에 도달해도 두 범위를 모두 제공한다", () => {
  const original = Array<string>(20_000).fill("기존");
  const revised = Array<string>(20_000).fill("신규");
  assert.deepEqual(lineDiff(original, revised), {
    grouped: true,
    changes: [{ oldStart: 0, oldEnd: 20_000, newStart: 0, newEnd: 20_000 }],
  });
});
