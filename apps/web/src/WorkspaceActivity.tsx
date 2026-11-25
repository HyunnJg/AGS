import { useState, useEffect } from "react";
import type { FileActivity } from "../../../packages/contracts/src/workspace.ts";
import { api, fileActivityError } from "./api.ts";

const labels = { entries: "폴더 탐색", file: "파일 읽기", search: "본문 검색", attach: "대화에 첨부" };
export function WorkspaceActivity({ token, project }: { token: string; project: string }) {
  const [rows, setRows] = useState<FileActivity[]>();
  const [error, setError] = useState("");
  const [request, setRequest] = useState({ project });
  useEffect(() => {
    const controller = new AbortController();
    api(token, `/api/projects/${request.project}/activity`, "GET", undefined, controller.signal)
      .then((r) => r.json())
      .then((data) => {
        if (!controller.signal.aborted) {
          setRows(data);
          setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "기록을 읽지 못했습니다.");
      });
    return () => controller.abort();
  }, [request, token]);
  return (
    <section aria-label="프로젝트 활동 기록" className="activity-list">
      <button type="button" onClick={() => setRequest({ project })}>
        기록 새로고침
      </button>
      {!rows && !error && <output>기록을 불러오는 중…</output>}
      {error && <p role="alert">{error}</p>}
      {rows?.length === 0 && <p>아직 파일 활동이 없습니다.</p>}
      {rows && (
        <ol>
          {rows.map((r) => (
            <li key={r.id}>
              <strong>{labels[r.action]}</strong> ·{" "}
              {r.error ? (r.error === "search_cancelled" ? "중단" : "실패") : "완료"}
              <time dateTime={new Date(r.time).toISOString()}>
                {new Date(r.time).toLocaleString("ko-KR")}
              </time>
              {r.path !== null && (
                <span>
                  {r.path || "작업 폴더"}
                  {r.start !== null && ` · ${r.start}–${r.end}줄`}
                </span>
              )}
              {r.error && <small>{fileActivityError(r.error)}</small>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
