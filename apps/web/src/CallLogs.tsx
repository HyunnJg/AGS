import { useEffect, useId, useState } from "react";
import { callKinds, usageLabels, type CallLog, type CallSummary } from "../../../packages/contracts/src/calls.ts";
import { providerNames } from "../../../packages/contracts/src/providers.ts";
import { BlockBudgetTable } from "./BlockBudgetTable.tsx";
import { api } from "./api.ts";

const statuses = {
  completed: "완료",
  failed: "실패",
  cancelled: "중단",
  timeout: "시간 초과",
};

function LogFilter({ label, options, value, change }: {
  label: string;
  options: Record<string, string>;
  value: string;
  change: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => change(event.target.value)}>
        <option value="">전체</option>
        {Object.entries(options).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select>
    </div>
  );
}

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
      <small>
        호출 ID {log.id}
        {log.session && ` · 대화 ${log.session}`}
      </small>
      <button type="button" onClick={() => download(log, `AGS-call-${id}.json`)}>
        이 호출 JSON 다운로드
      </button>
      <h4>요청 요약</h4>
      {log.request ? (
        <p>
          모델 {log.model} · 메시지 {log.request.messageCount}개 · 본문 합계{" "}
          {log.request.contentBytes.toLocaleString()} B (UTF-8)
          {" · 출력 한도 "}
          {log.request.maxTokens === null ? "미지정" : `${log.request.maxTokens.toLocaleString()}토큰`}
        </p>
      ) : (
        <p>
          {log.provider === "mock"
            ? noHttp
            : log.kind === "catalog"
              ? "모델 목록 조회 · 요청 본문 없음"
              : "저장된 요청 요약 없음"}
        </p>
      )}
      {log.contextBudget && (
        <>
          <h4>전송 시 입력 구성</h4>
          <p>
            AGS 추정 입력 {log.contextBudget.estimatedInput.toLocaleString()}토큰 · 입력 한도{" "}
            {log.contextBudget.inputCeiling === null
              ? "미지정"
              : `${log.contextBudget.inputCeiling.toLocaleString()}토큰`}
          </p>
          <BlockBudgetTable rows={log.contextBudget.blockUsage} />
        </>
      )}
      {log.kind !== "catalog" && log.provider !== "mock" && (
        <>
          <h4>공급자 보고 토큰</h4>
          <p>
            {log.usage
              ? (Object.keys(usageLabels) as (keyof typeof usageLabels)[])
                  .flatMap((key) => {
                    const count = log.usage?.[key];
                    return count === undefined ? [] : [`${usageLabels[key]} ${count.toLocaleString()}`];
                  })
                  .join(" · ")
              : "저장된 사용량 없음"}
          </p>
          {log.usage && log.status !== "completed" && <small>호출이 끝나기 전까지 받은 수치입니다.</small>}
        </>
      )}
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
  const [filters, setFilters] = useState({ provider: "", kind: "", status: "" });
  const visibleRows = rows?.filter((row) =>
    (!filters.provider || row.provider === filters.provider) &&
    (!filters.kind || row.kind === filters.kind) &&
    (!filters.status || row.status === filters.status)
  ) ?? [];
  const selectedId = visibleRows.find((row) => row.id === id)?.id ?? visibleRows[0]?.id;
  function changeFilter(key: keyof typeof filters, value: string) {
    setId(selectedId ?? "");
    setFilters((current) => ({ ...current, [key]: value }));
  }
  const [error, setError] = useState("");
  const [query, refresh] = useState({ path: "/api/call-logs" });
  const [loading, setLoading] = useState(true);
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
        setError("");
      })
      .catch(() => {
        if (!c.signal.aborted) setError("호출 목록을 읽지 못했습니다.");
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [token, query]);
  function reload(keepId = selectedId ?? "") {
    setId(keepId);
    setLoading(true);
    refresh({ path: "/api/call-logs" });
  }
  async function action(command: "download" | "toggle" | "clear") {
    if (
      command === "clear" &&
      !window.confirm("현재 저장된 호출 로그를 모두 비울까요? 대화 기록은 유지됩니다.")
    )
      return;
    setBusy(true);
    setError("");
    try {
      if (command === "download")
        download(
          await (await api(token, "/api/call-logs/export")).json(),
          `AGS-calls-${new Date().toISOString().slice(0, 10)}.json`,
        );
      else if (command === "clear") {
        await api(token, "/api/call-logs", "DELETE");
        setRows([]);
        reload("");
      } else {
        const response = await api(token, "/api/settings/call-logs", "PUT", { enabled: !enabled });
        setEnabled((await response.json()).enabled);
      }
    } catch {
      setError(
        {
          download: "로그를 내려받지 못했습니다.",
          toggle: "기록 설정을 변경하지 못했습니다.",
          clear: "로그를 비우지 못했습니다.",
        }[command],
      );
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
          disabled={enabled === undefined || busy || loading}
          onChange={() => void action("toggle")}
        />
        새 호출 기록
      </label>
      <small>최근 종료된 호출 100건을 이 PC에 보관합니다.</small>
      <div>
        <button type="button" disabled={busy || loading} onClick={() => reload()}>
          목록 새로고침
        </button>{" "}
        <button
          type="button"
          disabled={busy || loading || !rows?.length}
          onClick={() => void action("download")}
        >
          전체 JSON 다운로드
        </button>{" "}
        <button
          type="button"
          disabled={busy || loading || !rows?.length}
          onClick={() => void action("clear")}
        >
          로그 전체 비우기
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!rows && !error && <output>목록을 읽는 중…</output>}
      {rows && rows.length > 0 && (
        <>
          <fieldset className="call-log-filters" aria-label="호출 필터">
            <LogFilter label="공급자" options={providerNames} value={filters.provider} change={(v) => changeFilter("provider", v)} />
            <LogFilter label="호출 종류" options={callKinds} value={filters.kind} change={(v) => changeFilter("kind", v)} />
            <LogFilter label="종료 상태" options={statuses} value={filters.status} change={(v) => changeFilter("status", v)} />
          </fieldset>
          {(filters.provider || filters.kind || filters.status) && (
            <div>
              <output>{rows.length}건 중 {visibleRows.length}건</output>{" "}
              <button type="button" onClick={() => {
                setId(selectedId ?? "");
                setFilters({ provider: "", kind: "", status: "" });
              }}>필터 초기화</button>
            </div>
          )}
          {selectedId ? (
            <label>
              호출 선택
              <select value={selectedId} onChange={(e) => setId(e.target.value)}>
                {visibleRows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.started).toLocaleString()} · {callKinds[r.kind]} · {providerNames[r.provider]}{" "}
                    {r.model} · {statuses[r.status]}
                    {r.httpStatus ? ` · ${r.httpStatus}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : <p>조건에 맞는 호출이 없습니다.</p>}
        </>
      )}
      {rows?.length === 0 && <p>아직 기록된 호출이 없습니다.</p>}
      {selectedId && <CallDetail key={selectedId} id={selectedId} token={token} />}
    </div>
  );
}
