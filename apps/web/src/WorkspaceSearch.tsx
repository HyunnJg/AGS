import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  Project,
  SearchHit,
  WorkspaceSearch as SearchData,
} from "../../../packages/contracts/src/workspace.ts";
import { api } from "./api.ts";

export function WorkspaceSearch({
  project,
  token,
  folder,
  open,
}: {
  project: Project;
  token: string;
  folder: string;
  open: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [scope, setScope] = useState("");
  const [result, setResult] = useState<SearchData>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => () => request.current?.abort(), []);
  function reset() {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setResult(undefined);
    setError("");
  }
  async function search(e: FormEvent) {
    e.preventDefault();
    reset();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const response = await api(
        token,
        `/api/projects/${project.id}/search`,
        "POST",
        { path: scope, root: project.root, query, caseSensitive },
        controller.signal,
      );
      const data: SearchData = await response.json();
      if (request.current === controller) setResult(data);
    } catch (e) {
      if (request.current === controller && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : "검색을 완료하지 못했습니다.");
    } finally {
      if (request.current === controller) setBusy(false);
    }
  }
  return (
    <details ref={details} className="workspace-search">
      <summary>파일 내용 검색</summary>
      <form onSubmit={search}>
        <label>
          검색 문구
          <input
            value={query}
            maxLength={120}
            required
            onChange={(e) => {
              reset();
              setQuery(e.target.value);
            }}
          />
        </label>
        {(folder || scope) && (
          <label>
            검색 범위
            <select
              value={scope}
              onChange={(e) => {
                reset();
                setScope(e.target.value);
              }}
            >
              <option value="">작업 폴더 전체</option>
              {[...new Set([folder, scope].filter(Boolean))].map((path) => (
                <option key={path} value={path}>
                  {path}/
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="match-case">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => {
              reset();
              setCaseSensitive(e.target.checked);
            }}
          />
          대소문자 구분
        </label>
        <button type="submit" disabled={busy || !query.trim()}>
          검색
        </button>
        {busy && (
          <button type="button" onClick={reset}>
            검색 중단
          </button>
        )}
      </form>
      {busy && <output>검색 중…</output>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <output>
            일치한 줄 {result.hits.length}개 · 확인한 파일 {result.files}개
            {result.skipped > 0 && ` · 건너뛴 항목 ${result.skipped}개`}
          </output>
          {result.limited && <p>검색 한도에 도달했습니다. 하위 폴더나 더 구체적인 문구로 다시 검색하세요.</p>}
          <ul>
            {result.hits.map((hit) => (
              <li key={`${hit.path}:${hit.line}`}>
                <button
                  type="button"
                  onClick={() => {
                    open(hit);
                    if (details.current) details.current.open = false;
                  }}
                >
                  <strong>
                    {hit.path} · {hit.line}줄
                  </strong>
                  <span>{hit.excerpt}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
