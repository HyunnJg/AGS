import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

test("v9 작업실의 기존 대화를 유지하고 보관 상태를 재시작 후 복원한다", t => {
  const dir = mkdtempSync(join(tmpdir(), "ags-session-archive-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "sessions.sqlite");
  let db = new SessionStore(path);
  const { id } = db.create();
  db.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE archived_sessions; PRAGMA user_version=9");
  legacy.close();
  db = new SessionStore(path);
  assert.equal(db.get(id)?.archived, false);
  db.setSessionArchived(id, true);
  db.close();
  db = new SessionStore(path);
  try {
    assert.equal(db.list()[0]?.archived, true);
    db.setSessionArchived(id, false);
    assert.equal(db.get(id)?.archived, false);
  } finally {
    db.close();
  }
});

test("이전 CRLF 프리셋의 재등록은 기존 ID와 원본을 보존한다", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-preset-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "sessions.sqlite");
  new SessionStore(path).close();
  const old = new DatabaseSync(path);
  const id = "custom-00000000-0000-4000-8000-000000000001";
  const original = "# 원칙\r\n근거를 확인한다.\r\n";
  old.exec("ALTER TABLE custom_presets DROP COLUMN archived; PRAGMA user_version=7");
  old.prepare("INSERT INTO custom_presets VALUES(?,?,?)").run(id, "역사", original);
  old.close();
  const store = new SessionStore(path);
  try {
    const saved = store.addPreset("역사", "# 원칙\n근거를 확인한다.\n");
    assert.equal(saved.id, id);
    assert.equal(saved.instructions, original);
    assert.throws(() => store.addPreset("역사", original.trimEnd()), /preset_name_taken/);
    assert.equal(store.customPresets().length, 1);
  } finally {
    store.close();
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

test("기존 파일 첨부를 유지하고 지식 참조 설정을 재시작 후에도 복원한다", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "ags-knowledge-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "sessions.sqlite");
  let store = new SessionStore(path);
  const session = store.create();
  const project = store.addProject("전시");
  const file = store.addReference(session.id, project, "이전.md", "v1", 1, 1, "파일");
  store.close();
  const old = new DatabaseSync(path);
  old.exec("DROP TABLE custom_presets; ALTER TABLE shared_prompt DROP COLUMN responseLanguage; ALTER TABLE file_references DROP COLUMN kind; DROP TABLE reviews; PRAGMA user_version=3");
  old.close();
  store = new SessionStore(path);
  try {
    assert.equal(store.references(session.id)[0]?.id, file);
    assert.equal(store.references(session.id)[0]?.kind, "file");
    assert.throws(
      () => store.addReference(session.id, project, "이전.md", "v1", 1, 1, "파일", "knowledge"),
      /reference_kind_conflict/,
    );
    store.addReference(session.id, project, "출처.md", "v2", 3, 3, "지식", "knowledge");
    store.setKnowledgeEnabled(false);
    assert.throws(
      () => store.addReference(session.id, project, "출처.md", "v2", 4, 4, "지식", "knowledge"),
      /knowledge_disabled/,
    );
  } finally {
    store.close();
  }
  store = new SessionStore(path);
  try {
    assert.equal(store.memoryEnabled(), true);
    assert.equal(store.knowledgeEnabled(), false);
    assert.deepEqual(
      store.references(session.id).map((r) => [r.kind, r.paused]),
      [
        ["file", false],
        ["knowledge", true],
      ],
    );
    store.setMemoryEnabled(false);
    store.setKnowledgeEnabled(true);
    assert.equal(store.references(session.id)[1]?.paused, false);
    assert.equal(store.memoryEnabled(), false);
  } finally {
    store.close();
  }
});

test("대화 본문 검색은 한글·기호를 문자 그대로 찾고 턴 위치와 제한된 문맥을 반환한다", async t => {
  const db = new SessionStore(":memory:");
  t.after(() => db.close());
  const a = db.create(), b = db.create();
  const term = "한글 '%_";
  db.begin(a, "a1", "관련 없는 첫 질문");
  db.finish("a1", "completed");
  db.begin(b, "b1", term.normalize("NFD"));
  db.finish("b1", "completed");
  db.begin(a, "a2", `${"📝".repeat(40)}x${term}${"뒤".repeat(60)}`);
  db.append("a2", `부분 답변 ${term}`);
  db.finish("a2", "cancelled");
  for (let i = 0; i < 34; i++) {
    db.begin(b, `other-${i}`, "빈도");
    db.finish(`other-${i}`, "completed");
  }
  const { results, truncated } = await db.searchTurns(term.normalize("NFD"));
  assert.equal(truncated, false);
  assert.deepEqual(results.map(h => [h.sessionId, h.turnId, h.turnNumber, h.field]), [
    [a.id, "a2", 2, "message"], [a.id, "a2", 2, "reply"], [b.id, "b1", 1, "message"],
  ]);
  assert.equal(results[0]?.title, "관련 없는 첫 질문");
  const snippet = results[0]?.snippet;
  assert.ok(snippet?.startsWith("…") && snippet.endsWith("…") && snippet.isWellFormed() && snippet.includes(term));
  assert.equal(results[1]?.snippet, `부분 답변 ${term}`);
  assert.equal(results[2]?.snippet, term);
  assert.deepEqual(await db.searchTurns("%X"), { results: [], truncated: false });
  const common = await db.searchTurns("빈도");
  assert.equal(common.truncated, true);
  assert.equal(common.results.length, 30);
  assert.equal(common.results.at(-1)?.turnId, "other-4");
});
