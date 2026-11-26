import { useEffect, useState } from "react";
import { callKinds, type CallLog, type CallSummary } from "../../../packages/contracts/src/calls.ts";
import { providerNames } from "../../../packages/contracts/src/providers.ts";
import { api } from "./api.ts";

const statuses = { completed: "완료", failed: "실패", cancelled: "중단", timeout: "시간 초과" };

function download(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CallDetail({ token, id }: { token: string; id: string }) {
  const [log, setLog] = useState<CallLog>();
  const [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    api(token, `/api/call-logs/${id}`, "GET", undefined, c.signal)
      .then((r) => r.json())
      .then((data) => {
        if (!c.signal.aborted) setLog(data);
      })
      .catch(() => {
        if (!c.signal.aborted) setError("기록을 열 수 없습니다. 목록을 새로고침하세요.");
      });
    return () => c.abort();
  }, [token, id]);
  if (!log) return <output>{error || "기록을 여는 중…"}</output>;
  const noHttp = log.provider === "mock" ? "로컬 mock 호출" : "HTTP 응답 없음";
  return (
    <section className="call-detail" aria-label="호출 상세">
      <p>
        {new Date(log.started).toLocaleString()} · {statuses[log.status]} · {log.durationMs}ms ·{" "}
        {log.httpStatus ? `HTTP ${log.httpStatus}` : noHttp}
      </p>
      <small>호출 ID {log.id}{log.session && ` · 대화 ${log.session}`}</small>
      <button type="button" onClick={() => download(log, `AGS-call-${id}.json`)}>
        이 호출 JSON 다운로드
      </button>
      <h4>응답 헤더</h4>
      <pre>{log.httpStatus ? JSON.stringify(log.headers, null, 2) : noHttp}</pre>
      <h4>응답 본문</h4>
      <pre>{log.body || (log.httpStatus ? "수신한 본문 없음" : noHttp)}</pre>
      {log.bodyLimited && <small>본문 일부만 기록했습니다.</small>}
      <h4>{log.status === "completed" ? "최종 답변" : "종료 전까지 받은 답변"}</h4>
      <pre>{log.answer || (log.kind === "catalog" ? "모델 목록 조회" : "수신한 답변 없음")}</pre>
      {log.answerLimited && <small>답변 일부만 기록했습니다.</small>}
    </section>
  );
}

export function CallLogs({ token }: { token: string }) {
  const [rows, setRows] = useState<CallSummary[]>();
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const [query, refresh] = useState({ path: "/api/call-logs" });
  useEffect(() => {
    const c = new AbortController();
    Promise.all([
      api(token, query.path, "GET", undefined, c.signal).then((r) => r.json()),
      api(token, "/api/settings/call-logs", "GET", undefined, c.signal).then((r) => r.json()),
    ])
      .then(([items, setting]: [CallSummary[], { enabled: boolean }]) => {
        if (c.signal.aborted) return;
        setRows(items);
        setEnabled(setting.enabled);
        setId((current) => (items.some((r) => r.id === current) ? current : (items[0]?.id ?? "")));
        setError("");
      })
      .catch(() => {
        if (!c.signal.aborted) setError("호출 목록을 읽지 못했습니다.");
      });
    return () => c.abort();
  }, [token, query]);
  async function action(exportAll: boolean) {
    setBusy(true);
    setError("");
    try {
      if (exportAll)
        download(
          await (await api(token, "/api/call-logs/export")).json(),
          `AGS-calls-${new Date().toISOString().slice(0, 10)}.json`,
        );
      else
        setEnabled(
          (await (await api(token, "/api/settings/call-logs", "PUT", { enabled: !enabled })).json()).enabled,
        );
    } catch {
      setError(exportAll ? "로그를 내려받지 못했습니다." : "기록 설정을 변경하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="call-logs">
      <label className="match-case">
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={enabled === undefined || busy}
          onChange={() => void action(false)}
        />
        새 호출 기록
      </label>
      <small>최근 종료된 호출 100건을 이 PC에 보관합니다.</small>
      <div>
        <button type="button" disabled={busy} onClick={() => refresh({ path: "/api/call-logs" })}>
          목록 새로고침
        </button>{" "}
        <button type="button" disabled={busy || !rows?.length} onClick={() => void action(true)}>
          전체 JSON 다운로드
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!rows && !error && <output>목록을 읽는 중…</output>}
      {rows &&
        (rows.length ? (
          <label>
            호출 선택
            <select value={id} onChange={(e) => setId(e.target.value)}>
              {rows.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.started).toLocaleString()} · {callKinds[r.kind]} · {providerNames[r.provider]}{" "}
                  {r.model} · {statuses[r.status]}
                  {r.httpStatus ? ` · ${r.httpStatus}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p>아직 기록된 호출이 없습니다.</p>
        ))}
      {id && <CallDetail key={id} id={id} token={token} />}
    </div>
  );
}
