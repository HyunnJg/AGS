import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { DirectoryPage, FilePage, WorkspaceSearch } from "../../../packages/contracts/src/workspace.ts";

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
export function validPart(value: string) {
  return (
    !!value &&
    !value.toLowerCase().startsWith(".ags-stage-") &&
    value !== "." &&
    value !== ".." &&
    !/[\\/:*?"<>|]/u.test(value) &&
    Array.from(value).every((c) => c.charCodeAt(0) >= 32) &&
    !/[. ]$/.test(value) &&
    !/^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)
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
export async function locate(root: RegisteredRoot, path: string) {
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
export async function readSnapshot(root: RegisteredRoot, path: string, reserve?: (bytes: number) => void) {
  const node = await locate(root, path);
  if (!node.stat.isFile()) deny();
  if (node.stat.nlink !== 1n) throw new WorkspaceError(403, "hardlink_not_supported");
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
    reserve?.(Number(stat.size));
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
    return { text, bytes: data.subarray(0, used), stat: after, id: node.id };
  } finally {
    await handle.close();
  }
}

async function readText(root: RegisteredRoot, path: string, reserve?: (bytes: number) => void) {
  return (await readSnapshot(root, path, reserve)).text;
}

function versionOf(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
export async function readLines(
  root: RegisteredRoot,
  path: string,
  start: number,
  version?: string,
  count = 80,
): Promise<FilePage> {
  const text = await readText(root, path);
  const currentVersion = versionOf(text);
  if (version && currentVersion !== version) throw new WorkspaceError(409, "search_result_changed");
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  if (start > Math.max(1, lines.length)) throw new WorkspaceError(400, "invalid_range");
  const page = lines.slice(start - 1, start - 1 + count);
  const clipped = page.some((line) => line.length > 2048);
  return {
    start,
    end: start - 1 + page.length,
    total: lines.length,
    version: currentVersion,
    clipped,
    text: page.map((line) => line.slice(0, 2048)).join("\n"),
  };
}

const excluded = new Set([".git", "node_modules", "dist"]);
type SearchEntry = { name: string; directory: boolean };
async function searchDirectory(root: RegisteredRoot, path: string, remaining: number) {
  const node = await locate(root, path);
  if (!node.stat.isDirectory()) throw new WorkspaceError(400, "not_directory");
  const entries: SearchEntry[] = [];
  let seen = 0;
  let limited = false;
  const dir = await opendir(node.target);
  for await (const entry of dir) {
    if (seen === remaining) {
      limited = true;
      break;
    }
    seen++;
    if (!validPart(entry.name) || !(entry.isDirectory() || entry.isFile())) continue;
    if (entry.isDirectory() && excluded.has(entry.name.toLowerCase())) continue;
    entries.push({ name: entry.name, directory: entry.isDirectory() });
  }
  if ((await locate(root, path)).id !== node.id) deny();
  entries.sort((a, b) => a.name.localeCompare(b.name, "ko") || (a.name < b.name ? -1 : 1));
  return { entries, seen, limited };
}
function skipSearchEntry(e: unknown) {
  if (e instanceof WorkspaceError)
    return [
      "outside_workspace",
      "hardlink_not_supported",
      "file_too_large",
      "not_text",
      "file_changed",
    ].includes(e.message);
  return (
    !!e &&
    typeof e === "object" &&
    "code" in e &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "ESTALE"].includes(String(e.code))
  );
}

export async function searchWorkspace(
  root: RegisteredRoot,
  scope: string,
  query: string,
  checkActive: () => void,
  caseSensitive = true,
  options: { include?: (entry: SearchEntry) => boolean; firstOnly?: boolean } = {},
): Promise<WorkspaceSearch> {
  if (scope.split("/").some((part) => excluded.has(part.toLowerCase())))
    throw new WorkspaceError(400, "excluded_folder");
  const literal = caseSensitive ? null : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  const result: WorkspaceSearch = { hits: [], files: 0, skipped: 0, limited: false };
  const folders = [scope];
  let remainingEntries = 1500;
  let remainingBytes = 8 * 1024 * 1024;
  let attempted = 0;
  traversal: for (const [i, folder] of folders.entries()) {
    checkActive();
    let dir: Awaited<ReturnType<typeof searchDirectory>>;
    try {
      dir = await searchDirectory(root, folder, remainingEntries);
    } catch (e) {
      if (i === 0 || !skipSearchEntry(e)) throw e;
      result.skipped++;
      continue;
    }
    remainingEntries -= dir.seen;
    result.limited ||= dir.limited;
    for (const entry of dir.entries) {
      checkActive();
      if (options.include && !options.include(entry)) continue;
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.directory) {
        folders.push(path);
        continue;
      }
      if (++attempted > 200) {
        result.limited = true;
        break traversal;
      }
      let text: string;
      try {
        text = await readText(root, path, (bytes) => {
          if (bytes > remainingBytes) throw new WorkspaceError(413, "search_budget");
          remainingBytes -= bytes;
        });
      } catch (e) {
        if (e instanceof WorkspaceError && e.message === "search_budget") {
          result.limited = true;
          break traversal;
        }
        if (!skipSearchEntry(e)) throw e;
        result.skipped++;
        continue;
      }
      result.files++;
      if (!(literal ? literal.test(text) : text.includes(query))) continue;
      const version = versionOf(text);
      const lines = text.split(/\r\n|\n|\r/);
      for (const [index, line] of lines.entries()) {
        const hit = literal ? line.search(literal) : line.indexOf(query);
        if (hit < 0) continue;
        if (result.hits.length === 50) {
          result.limited = true;
          break traversal;
        }
        const from = Math.max(0, hit - 32),
          to = Math.min(line.length, hit + query.length + 48);
        result.hits.push({
          path,
          line: index + 1,
          version,
          excerpt: (from ? "…" : "") + line.slice(from, to) + (to < line.length ? "…" : ""),
        });
        if (options.firstOnly) break traversal;
      }
    }
    if (!remainingEntries && i + 1 < folders.length) {
      result.limited = true;
      break;
    }
  }
  await locate(root, scope);
  return result;
}
