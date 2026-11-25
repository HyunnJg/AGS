import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile, rename, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listEntries,
  readLines,
  registerFolder,
  searchWorkspace,
} from "../apps/server/src/workspace-files.ts";

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
  await assert.rejects(readLines(root, "copy", 1), /hardlink_not_supported/);
  await rename(workspace, join(base, "archived"));
  await mkdir(workspace);
  await assert.rejects(listEntries(root, "", 0), /outside_workspace/);
});

test("작업 폴더 검색은 원본 줄과 버전을 반환하고 제외 폴더와 읽지 못하는 파일을 건너뛴다", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "ags-search-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await registerFolder(base, "");
  for (const folder of ["docs", ".git", "node_modules", "dist"]) {
    await mkdir(join(base, folder));
    await writeFile(join(base, folder, "note.md"), "소개\r\n근거 [1]\r\n끝");
  }
  await writeFile(join(base, "data.bin"), Buffer.from([0xff]));
  const result = await searchWorkspace(root, "", "[1]", () => {});
  assert.equal(result.limited, false);
  assert.equal(result.files, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.hits.length, 1);
  const hit = result.hits[0];
  assert.ok(hit);
  assert.equal(hit.path, "docs/note.md");
  assert.equal(hit.line, 2);
  assert.equal(hit.excerpt, "근거 [1]");
  assert.equal((await readLines(root, hit.path, 2, hit.version)).text, "근거 [1]\n끝");
  await writeFile(join(base, hit.path), "첫 줄 추가\n소개\n근거 [1]");
  await assert.rejects(readLines(root, hit.path, 2, hit.version), /search_result_changed/);
  await assert.rejects(
    searchWorkspace(root, "dist", "근거", () => {}),
    /excluded_folder/,
  );
  await writeFile(join(base, "docs", "many.md"), "같은 줄\n".repeat(51));
  const many = await searchWorkspace(root, "docs", "같은 줄", () => {});
  assert.equal(many.hits.length, 50);
  assert.equal(many.limited, true);
  const none = await searchWorkspace(root, "docs", "없는 문구", () => {});
  assert.equal(none.hits.length, 0);
  assert.equal(none.limited, false);
  let activeChecks = 0;
  await assert.rejects(
    searchWorkspace(root, "docs", "근거", () => {
      if (++activeChecks === 2) throw new Error("folder_changed");
    }),
    /folder_changed/,
  );
});
