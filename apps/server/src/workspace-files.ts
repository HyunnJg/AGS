import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { DirectoryPage, FilePage } from "../../../packages/contracts/src/workspace.ts";

export class WorkspaceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export interface RegisteredRoot {
  path: string;
  identity: string;
}
function deny(): never {
  throw new WorkspaceError(403, "outside_workspace");
}
function sameOrBelow(base: string, path: string) {
  const rel = relative(base, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
async function identity(path: string) {
  const stat = await lstat(path, { bigint: true });
  return { stat, id: `${stat.dev}:${stat.ino}` };
}
function validPart(value: string) {
  return (
    !!value &&
    value !== "." &&
    value !== ".." &&
    !/[\\/:]/u.test(value) &&
    Array.from(value).every((c) => c.charCodeAt(0) >= 32) &&
    !/[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)
  );
}
export async function registerFolder(input: string, privateDir: string): Promise<RegisteredRoot> {
  if (
    !isAbsolute(input) ||
    /^[/\\]{2}/.test(input) ||
    (process.platform === "win32" && !/^[a-z]:[/\\]/i.test(input))
  )
    throw new WorkspaceError(400, "invalid_folder");
  const path = resolve(input);
  if (path === parse(path).root) deny();
  const selected = await identity(path);
  if (!selected.stat.isDirectory() || selected.stat.isSymbolicLink()) deny();
  // Windows may expand an 8.3 ancestor name. Pin the actual directory, not the spelling.
  const canonical = await realpath(path);
  if (canonical === parse(canonical).root || /^[/\\]{2}/.test(canonical)) deny();
  if (privateDir) {
    const state = await realpath(privateDir);
    if (sameOrBelow(canonical, state) || sameOrBelow(state, canonical)) deny();
  }
  const { stat, id } = await identity(canonical);
  if (!stat.isDirectory() || id !== selected.id) deny();
  return { path: canonical, identity: id };
}
async function locate(root: RegisteredRoot, path: string) {
  const parts = path === "" ? [] : path.split("/");
  if (parts.some((p) => !validPart(p))) deny();
  const base = await identity(root.path);
  if (base.id !== root.identity || !base.stat.isDirectory()) deny();
  let target = root.path;
  let node = base;
  for (const part of parts) {
    target = join(target, part);
    node = await identity(target);
    if (node.stat.isSymbolicLink()) deny();
  }
  if (relative(target, await realpath(target)) !== "") deny();
  return { target, ...node };
}
export async function listEntries(
  root: RegisteredRoot,
  path: string,
  offset: number,
): Promise<DirectoryPage> {
  const node = await locate(root, path);
  if (!node.stat.isDirectory()) throw new WorkspaceError(400, "not_directory");
  const rows = await readdir(node.target, { withFileTypes: true });
  if ((await locate(root, path)).id !== node.id) deny();
  const entries = rows
    .filter((r) => validPart(r.name) && (r.isFile() || r.isDirectory()))
    .map((r) => ({
      name: r.name,
      kind: r.isDirectory() ? ("folder" as const) : ("file" as const),
    }))
    .sort(
      (a, b) =>
        Number(b.kind === "folder") - Number(a.kind === "folder") ||
        a.name.localeCompare(b.name, "ko") ||
        (a.name < b.name ? -1 : 1),
    );
  return {
    entries: entries.slice(offset, offset + 100),
    next: offset + 100 < entries.length ? offset + 100 : null,
  };
}
const maxBytes = 1024 * 1024;
export async function readLines(root: RegisteredRoot, path: string, start: number): Promise<FilePage> {
  const node = await locate(root, path);
  if (!node.stat.isFile() || node.stat.nlink !== 1n) deny();
  const handle = await open(
    node.target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.dev !== node.stat.dev ||
      stat.ino !== node.stat.ino ||
      stat.nlink !== 1n ||
      (await locate(root, path)).id !== node.id
    )
      deny();
    if (stat.size > maxBytes) throw new WorkspaceError(413, "file_too_large");
    const data = Buffer.alloc(Number(stat.size));
    let used = 0;
    while (used < data.length) {
      const { bytesRead } = await handle.read(data, used, data.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      (await locate(root, path)).id !== node.id
    )
      throw new WorkspaceError(409, "file_changed");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, used));
    } catch {
      throw new WorkspaceError(415, "not_text");
    }
    if (data.subarray(0, used).some((b) => b < 9 || (b > 13 && b < 32)))
      throw new WorkspaceError(415, "not_text");
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.at(-1) === "") lines.pop();
    if (start > Math.max(1, lines.length)) throw new WorkspaceError(400, "invalid_range");
    const page = lines.slice(start - 1, start + 79);
    const clipped = page.some((line) => line.length > 2048);
    return {
      start,
      end: start - 1 + page.length,
      total: lines.length,
      clipped,
      text: page.map((line) => line.slice(0, 2048)).join("\n"),
    };
  } finally {
    await handle.close();
  }
}
