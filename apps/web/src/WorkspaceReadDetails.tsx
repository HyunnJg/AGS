import type { WorkspaceRead } from "../../../packages/contracts/src/workspace.ts";

export function WorkspaceReadDetails({ reads }: { reads: WorkspaceRead[] }) {
  if (!reads.length) return null;
  return <details>
    <summary>작업 폴더 조회 · {reads.length}회</summary>
    <ol>{reads.map(read => <li key={read.tool}>
      {read.tool === "list_entries"
        ? `폴더 목록 · ${read.path || "작업 폴더"}${read.failed ? "" : ` · ${read.count}개`}${read.limited ? " · 범위 제한" : ""}`
        : read.tool === "search_workspace"
        ? `본문 검색 · “${read.query}”${read.failed ? "" : read.matched ? " · 일치" : " · 일치 없음"}${read.limited ? " · 범위 제한" : ""}`
        : `파일 읽기 · ${read.path} · ${read.start}–${read.end}줄`}
      {read.failed && " · 실패"}
    </li>)}</ol>
  </details>;
}
