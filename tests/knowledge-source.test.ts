import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkKnowledgeSource } from "../apps/server/src/knowledge-source.ts";
import { SessionStore } from "../apps/server/src/sessions.ts";
import { readLines, registerFolder } from "../apps/server/src/workspace-files.ts";

test("지식 원본 비교는 대화의 스냅샷과 현재 폴더를 기준으로 변경 및 확인 불가를 구분한다", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ags-source-"));
  const folder = join(dir, "example");
  await mkdir(folder);
  const root = await registerFolder(folder, "");
  const path = "guide.md";
  const db = new SessionStore(join(dir, "session.sqlite"));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const project = db.addProject("예제");
  db.linkRoot(project, null, root);
  const session = db.create(),
    other = db.create();
  await writeFile(join(folder, path), "선택한 줄\n다른 줄");
  const { version } = await readLines(root, path, 1);
  const id = db.addReference(session.id, project, path, version, 1, 1, "선택한 줄", "knowledge");
  const ordinary = db.addReference(session.id, project, path, version, 2, 2, "다른 줄");
  assert.ok(id && ordinary);
  await assert.rejects(checkKnowledgeSource(db, other.id, id), /unknown_knowledge_reference/);
  await assert.rejects(checkKnowledgeSource(db, session.id, ordinary), /unknown_knowledge_reference/);
  const check = () => checkKnowledgeSource(db, session.id, id);
  assert.equal((await check()).status, "current");
  await writeFile(join(folder, path), "선택한 줄\n다른 줄 수정");
  assert.equal((await check()).status, "changed");
  await rm(join(folder, path));
  assert.equal((await check()).status, "unavailable");
  db.linkRoot(project, root.path, null);
  assert.equal((await check()).status, "unavailable");
  assert.equal(db.references(session.id)[0]?.version, version);
  assert.equal(db.references(session.id)[0]?.text, "선택한 줄");
});
