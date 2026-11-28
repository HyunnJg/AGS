import { createHash } from "node:crypto";
import type { Session } from "../../../packages/contracts/src/sessions.ts";
import type { WorkspaceRead } from "../../../packages/contracts/src/workspace.ts";
import type { SessionStore } from "./sessions.ts";
import { searchWorkspace, readLines, WorkspaceError, type RegisteredRoot } from "./workspace-files.ts";

export function workspaceScope(store: SessionStore, session: Session) {
  const project = session.sectionId && store.sectionProject(session.sectionId);
  const folder = project && store.project(project);
  if (session.provider !== "mock" || !project || !folder || !folder.root || !folder.identity) return;
  const scope = createHash("sha256").update(JSON.stringify([
    session.id, session.sectionId, session.sectionRevision, session.model, project, folder.root, folder.identity,
  ])).digest("hex");
  return { scope, project, root: { path: folder.root, identity: folder.identity } };
}

export function searchPhrase(message: string) {
  const phrase = (message.match(/"([^"\n]+)"|“([^”\n]+)”/u)?.slice(1).find(Boolean) ?? message).trim();
  if (!phrase || phrase.length > 120 || /[\p{Cc}]/u.test(phrase))
    throw new WorkspaceError(400, "invalid_tool_query");
  return phrase;
}

// The local mock makes at most one search followed by one version-pinned read.
// Only the first matching location and a single source line are returned to it.
export async function* mockWorkspaceReply(root: RegisteredRoot, query: string, check: () => void,
  record: (row: WorkspaceRead) => void) {
  let remaining = 8192;
  function accept(data: unknown) {
    check();
    remaining -= Buffer.byteLength(JSON.stringify(data));
    if (remaining < 0) throw new WorkspaceError(413, "tool_result_limit");
  }
  const search: WorkspaceRead = { tool: "search_workspace", path: "", query };
  let found: Awaited<ReturnType<typeof searchWorkspace>>;
  try {
    check();
    found = await searchWorkspace(root, "", query, check, false, {
      firstOnly: true,
      include: ({ name, directory }) => !name.startsWith(".") && (directory || /\.(?:md|txt)$/i.test(name)),
    });
    const first = found.hits[0];
    accept(first ? { path: first.path, line: first.line, version: first.version } : null);
  } catch (error) {
    record({ ...search, failed: true });
    throw error;
  }
  const hit = found.hits[0];
  record({ ...search, matched: !!hit, limited: found.limited });
  if (!hit) {
    yield found.limited || found.skipped
      ? "확인한 문서 범위에서 일치하는 줄을 찾지 못했습니다. 일부 파일은 검색하지 못했습니다."
      : "작업 폴더의 Markdown·텍스트 문서에서 일치하는 줄을 찾지 못했습니다.";
    return;
  }
  const read: WorkspaceRead = { tool: "read_file", path: hit.path, start: hit.line, end: hit.line, version: hit.version };
  let text: string;
  try {
    check();
    const page = await readLines(root, hit.path, hit.line, hit.version, 1);
    if (page.clipped) throw new WorkspaceError(413, "tool_result_limit");
    accept({ path: hit.path, line: hit.line, text: page.text });
    text = page.text;
  } catch (error) {
    record({ ...read, failed: true });
    throw error;
  }
  record(read);
  yield `작업 폴더에서 확인한 원문 · ${hit.path} · ${hit.line}줄\n\n${text}`;
}
