import type { KnowledgeSourceCheck } from "../../../packages/contracts/src/workspace.ts";
import type { SessionStore } from "./sessions.ts";
import { readLines, WorkspaceError } from "./workspace-files.ts";

export async function checkKnowledgeSource(
  store: SessionStore,
  session: string,
  id: string,
): Promise<KnowledgeSourceCheck> {
  const ref = store.knowledgeSource(session, id);
  if (!ref) throw new WorkspaceError(404, "unknown_knowledge_reference");
  const project = store.project(ref.project);
  let status: KnowledgeSourceCheck["status"] = "unavailable";
  if (project?.root && project.identity) {
    const root = { path: project.root, identity: project.identity };
    try {
      // readLines checks the version of the entire file before extracting lines.
      await readLines(root, ref.path, 1, ref.version, 1);
      status = "current";
    } catch (e) {
      if (e instanceof WorkspaceError && e.message === "search_result_changed") status = "changed";
      else if (!(e instanceof WorkspaceError) && !(e instanceof Error && "code" in e)) throw e;
    }
    const current = store.project(ref.project);
    if (current?.root !== root.path || current.identity !== root.identity) status = "unavailable";
    if (!store.knowledgeSource(session, id)) throw new WorkspaceError(404, "unknown_knowledge_reference");
    store.recordFileActivity(
      ref.project,
      "verify",
      ref.path,
      status === "unavailable" ? "source_unavailable" : null,
    );
  }
  return { status, checkedAt: Date.now() };
}
