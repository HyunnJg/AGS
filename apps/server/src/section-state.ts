import { maxReferenceChars } from "../../../packages/contracts/src/workspace.ts";
import { readLines, WorkspaceError, type RegisteredRoot } from "./workspace-files.ts";
import type { SessionStore } from "./sessions.ts";

export async function stateText(root: RegisteredRoot, path: string, version: string) {
  const page = await readLines(root, path, 1, version);
  if (!page.text.trim() || page.clipped || page.total !== page.end || page.text.length > maxReferenceChars)
    throw new WorkspaceError(400, "invalid_state_file");
  return page.text;
}

// Check the binding again at admission so a disconnect or toggle during IO takes effect.
export async function loadSectionState(store: SessionStore, sectionId?: string | null) {
  const source = sectionId ? store.activeState(sectionId) : undefined;
  if (!source) return;
  try {
    const text = await stateText(
      { path: source.root, identity: source.identity },
      source.path,
      source.version,
    );
    return { key: source.key, text: `섹션 현재 상태 (참고 자료) · ${source.path}\n${text}`, stale: false };
  } catch (error) {
    if (!(error instanceof WorkspaceError) && !(error instanceof Error && "code" in error)) throw error;
    return { key: source.key, text: "", stale: true };
  }
}
