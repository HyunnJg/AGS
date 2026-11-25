import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "../apps/server/src/sessions.ts";

test("중복 활성 턴을 막고 비정상 종료된 턴의 부분 텍스트와 프리셋을 복원한다", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "test.sqlite");
  const first = new SessionStore(path);
  const a = first.create();
  const b = first.create();
  first.setPreset(a.id, "coding");
  const configured = first.get(a.id);
  assert.ok(configured);
  assert.ok(first.begin(configured, "turn1", "첫 작업"));
  first.append("turn1", "받은 조각");
  assert.equal(first.begin(configured, "turn2", "중복"), false);
  assert.throws(() => new SessionStore(path));
  assert.equal(first.turns(a.id)[0]?.status, "streaming");
  first.close();
  const second = new SessionStore(path);
  try {
    assert.equal(second.get(a.id)?.preset, "coding");
    assert.equal(second.get(a.id)?.title, "첫 작업");
    assert.deepEqual(
      second.turns(a.id).map((row) => ({ ...row })),
      [
        {
          id: "turn1",
          message: "첫 작업",
          reply: "받은 조각",
          status: "interrupted",
          preset: "coding",
          provider: "mock",
          model: "",
        },
      ],
    );
    assert.deepEqual(second.turns(b.id), []);
    assert.ok(second.begin(configured, "turn3", "재개"));
  } finally {
    second.close();
  }
});

test("프로젝트별 최신 파일 활동 100건을 재시작 뒤에도 유지한다", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-activity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "sessions.sqlite"),
    db = new SessionStore(path);
  const a = db.addProject("첫 프로젝트"),
    b = db.addProject("다른 프로젝트");
  db.recordFileActivity(b, "search", "", null);
  for (let i = 1; i <= 105; i++) db.recordFileActivity(a, "file", "notes.md", null, i, i);
  db.close();
  const reopened = new SessionStore(path);
  try {
    const rows = reopened.fileActivity(a);
    assert.equal(rows.length, 100);
    assert.equal(rows[0]?.start, 105);
    assert.equal(rows.at(-1)?.start, 6);
    assert.equal(reopened.fileActivity(b).length, 1);
  } finally {
    reopened.close();
  }
});

test("첨부 자료는 대화별로 복원되고 같은 요청을 재시도해도 중복되지 않는다", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-refs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "sessions.sqlite"),
    db = new SessionStore(path);
  const a = db.create(),
    b = db.create(),
    project = db.addProject("자료");
  const attach = (line: number) => db.addReference(a.id, project, "notes.md", "v", line, line, "선택한 줄");
  const first = attach(1);
  assert.ok(first);
  for (let line = 2; line <= 8; line++) assert.ok(attach(line));
  assert.equal(attach(9), null);
  assert.equal(attach(1), first);
  db.removeReference(b.id, first);
  db.close();
  const next = new SessionStore(path);
  try {
    assert.equal(next.references(a.id).length, 8);
    assert.equal(next.references(b.id).length, 0);
    assert.equal(next.fileActivity(project).length, 8);
    assert.ok(!JSON.stringify(next.fileActivity(project)).includes("선택한 줄"));
    next.removeReference(a.id, first);
    assert.equal(next.references(a.id).length, 7);
  } finally {
    next.close();
  }
});
