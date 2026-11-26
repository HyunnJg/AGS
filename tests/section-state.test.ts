import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../apps/server/src/sessions.ts";
import { readLines, registerFolder } from "../apps/server/src/workspace-files.ts";
import { stateText, loadSectionState } from "../apps/server/src/section-state.ts";
import { assembleContext } from "../apps/server/src/context.ts";
import { defaultLimits, defaultOrder, emptySources } from "../packages/contracts/src/context.ts";

test("섹션 상태는 승인한 원본 버전과 섹션에만 연결되며 재시작·토글·원본 변경을 구분한다", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "ags-section-state-"));
  const folder = join(base, "workspace"),
    state = join(base, "private");
  await mkdir(folder);
  await mkdir(state);
  const path = "STATUS.md",
    file = join(folder, path),
    database = join(state, "test.sqlite");
  const text = "목표: 전시 준비\n결정: 토요일 개관\n다음: 연표 검토";
  await writeFile(file, text);
  let db = new SessionStore(database);
  t.after(async () => {
    db.close();
    await rm(base, { force: true, recursive: true });
  });
  const project = db.addProject("전시"),
    other = db.addProject("다른 전시");
  const section = db.addSection(project, "기획"),
    sibling = db.addSection(project, "운영");
  const root = await registerFolder(folder, state);
  db.linkRoot(project, null, root);
  const version = (await readLines(root, path, 1)).version;
  assert.ok(db.setStateSource(project, section, null, path, version));
  assert.equal(db.setStateSource(other, section, null, path, version), false);
  assert.equal(db.setStateSource(project, section, null, path, null), false);
  assert.equal(await loadSectionState(db, sibling), undefined);
  assert.equal(await loadSectionState(db, null), undefined);
  db.setMemoryEnabled(false);
  db.close();
  db = new SessionStore(database);
  assert.equal(db.memoryEnabled(), false);
  assert.equal(await loadSectionState(db, section), undefined);
  db.setMemoryEnabled(true);
  const loaded = await loadSectionState(db, section);
  assert.ok(loaded);
  assert.ok(loaded.text.includes("연표 검토"));
  const baseline = assembleContext("general", "", defaultLimits, [], "초안");
  const preview = assembleContext(
    "general",
    "",
    { ...defaultLimits, inputBudget: baseline.estimatedInput },
    [],
    "초안",
    null,
    defaultOrder,
    emptySources,
    [],
    loaded.text,
  );
  assert.deepEqual(preview.excluded, ["memory"]);
  assert.deepEqual(preview.messages, baseline.messages);
  await writeFile(file, "다른 버전");
  assert.equal((await loadSectionState(db, section))?.text, "");
  await unlink(file);
  assert.equal((await loadSectionState(db, section))?.stale, true);
  await writeFile(file, "a\n".repeat(81));
  await assert.rejects(stateText(root, path, (await readLines(root, path, 1)).version), /invalid_state_file/);
  db.linkRoot(project, root.path, null);
  db.linkRoot(project, null, root);
  assert.equal(await loadSectionState(db, section), undefined);
});
