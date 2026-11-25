import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile, rename, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEntries, readLines, registerFolder } from "../apps/server/src/workspace-files.ts";

test("등록 폴더의 목록·UTF-8 줄 범위와 파일 형식을 확인한다", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "ags-files-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await registerFolder(base, "");
  await mkdir(join(base, "자료"));
  await writeFile(
    join(base, "자료", "INDEX.md"),
    Array.from({ length: 90 }, (_, i) => `항목 ${i + 1}`)
      .concat("")
      .join("\r\n"),
  );
  await writeFile(join(base, "빈 파일"), "");
  await writeFile(join(base, "binary"), Buffer.from([0xff]));
  const listing = await listEntries(root, "", 0);
  assert.deepEqual(listing.entries[0], { name: "자료", kind: "folder" });
  assert.equal((await readLines(root, "자료/INDEX.md", 1)).end, 80);
  const last = await readLines(root, "자료/INDEX.md", 89);
  assert.deepEqual(last, { start: 89, end: 90, total: 90, clipped: false, text: "항목 89\n항목 90" });
  assert.equal((await readLines(root, "빈 파일", 1)).total, 0);
  await assert.rejects(readLines(root, "binary", 1), /not_text/);
  await assert.rejects(readLines(root, "자료/INDEX.md", 91), /invalid_range/);
  await writeFile(join(base, "large"), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(readLines(root, "large", 1), /file_too_large/);
});
test("등록한 실제 폴더의 정체성과 비공개 DB 경계를 유지한다", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "ags-roots-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "work"),
    privateDir = join(base, "private");
  await mkdir(workspace);
  await mkdir(privateDir);
  await assert.rejects(registerFolder(base, privateDir), /outside_workspace/);
  await assert.rejects(registerFolder(privateDir, privateDir), /outside_workspace/);
  const root = await registerFolder(workspace, privateDir);
  await mkdir(join(workspace, "notes"));
  await symlink(join(workspace, "notes"), join(workspace, "shortcut"), "junction");
  assert.deepEqual(
    (await listEntries(root, "", 0)).entries.map((e) => e.name),
    ["notes"],
  );
  await assert.rejects(listEntries(root, "shortcut", 0), /outside_workspace/);
  await assert.rejects(listEntries(root, "..", 0), /outside_workspace/);
  await writeFile(join(workspace, "original"), "note");
  await link(join(workspace, "original"), join(workspace, "copy"));
  await assert.rejects(readLines(root, "copy", 1), /outside_workspace/);
  await rename(workspace, join(base, "archived"));
  await mkdir(workspace);
  await assert.rejects(listEntries(root, "", 0), /outside_workspace/);
});
