import { downloadBlob } from "./download.ts";
import { useEffect, useId, useState } from "react";
import { callKinds, usageLabels, type CallLog, type CallSummary } from "../../../packages/contracts/src/calls.ts";
import type { Session } from "../../../packages/contracts/src/sessions.ts";
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
  downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }), filename);
}

function CallDetail({ token, id, sessionTitle }: { token: string; id: string; sessionTitle?: string }) {
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
      <small>호출 ID {log.id}{log.session && <> · 대화 {sessionTitle && `${sessionTitle} · `}{log.session}</>}</small>
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

function UsageTotals({ rows }: { rows: CallSummary[] }) {
  const calls = rows.filter(row => row.kind !== "catalog" && row.provider !== "mock");
  const reported = calls.filter(row => row.usage);
  const fields = (Object.keys(usageLabels) as (keyof typeof usageLabels)[]).flatMap(key => {
    let sum = 0n;
    let count = 0;
    for (const { usage } of reported) {
      const value = usage?.[key];
      if (value !== undefined) {
        sum += BigInt(value);
        count++;
      }
    }
    return count ? [{ key, sum, count }] : [];
  });
  return (
    <details className="usage-totals">
      <summary>필터 결과 토큰 사용량</summary>
      {calls.length === 0 ? <p>이 조건에 해당하는 모델 API 호출이 없습니다.</p> : (
        <>
          <p>모델 API 호출 {calls.length}건 중 {reported.length}건에서 사용량을 보고했습니다.</p>
          {fields.length > 0 && (
            <table aria-label="필터 결과 토큰 사용량">
              <thead><tr><th scope="col">항목</th><th scope="col">토큰 합계</th><th scope="col">보고한 호출</th></tr></thead>
              <tbody>
                {fields.map(({ key, sum, count }) => (
                  <tr key={key}>
                    <th scope="row">{usageLabels[key]}</th>
                    <td>{sum.toLocaleString()}</td>
                    <td>{count} / {calls.length}건</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </details>
  );
}

const usageListPath = "/api/call-logs?usage=1";
const noSession = "unassigned";
const emptyFilters = { session: "", provider: "", model: "", kind: "", status: "" };

export function CallLogs({ token, currentSession }: { token: string; currentSession?: Session }) {
  const [rows, setRows] = useState<CallSummary[]>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [id, setId] = useState("");
  const [filters, setFilters] = useState(emptyFilters);
  const sessionById = new Map(sessions.map(s => [s.id, s]));
  const sessionIds = new Set<string>();
  if (currentSession) sessionIds.add(currentSession.id);
  for (const row of rows ?? []) sessionIds.add(row.session ?? noSession);
  // A refresh may evict the last call for the selected conversation.
  if (filters.session) sessionIds.add(filters.session);
  const sessionOptions: Record<string, string> = {};
  const labelCounts = new Map<string, number>();
  for (const id of sessionIds) {
    const session = sessionById.get(id) ?? (id === currentSession?.id ? currentSession : undefined);
    const name = id === noSession ? "대화 미지정" :
      session ? [session.title, session.sectionLabel].filter(Boolean).join(" · ") : id;
    sessionOptions[id] = name;
    labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1);
  }
  for (const id of sessionIds) {
    if ((labelCounts.get(sessionOptions[id]) ?? 0) > 1 && id !== noSession) sessionOptions[id] += ` · ${id}`;
    if (id === currentSession?.id) sessionOptions[id] = `현재 대화 · ${sessionOptions[id]}`;
  }
  const modelIds = new Set<string>();
  for (const row of rows ?? []) {
    if (row.model && (!filters.provider || row.provider === filters.provider)) modelIds.add(row.model);
  }
  // Keep the selected ID visible if its last retained call is evicted on refresh.
  if (filters.model) modelIds.add(filters.model);
  const modelOptions = Object.fromEntries([...modelIds].sort().map(model => [model, model]));
  const visibleRows = rows?.filter((row) =>
    (!filters.session || (row.session ?? noSession) === filters.session) &&
    (!filters.provider || row.provider === filters.provider) &&
    (!filters.model || row.model === filters.model) &&
    (!filters.kind || row.kind === filters.kind) &&
    (!filters.status || row.status === filters.status)
  ) ?? [];
  const selected = visibleRows.find((row) => row.id === id) ?? visibleRows[0];
  const selectedId = selected?.id;
  function changeFilter(key: keyof typeof filters, value: string) {
    setId(selectedId ?? "");
    setFilters(current => {
      if (key === "provider" && value && current.model &&
          !rows?.some(row => row.provider === value && row.model === current.model)) {
        return { ...current, provider: value, model: "" };
      }
      return { ...current, [key]: value };
    });
  }
  const [error, setError] = useState("");
  const [query, refresh] = useState({ path: usageListPath });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const c = new AbortController();
    Promise.all([
      api(token, query.path, "GET", undefined, c.signal).then((r) => r.json()),
      api(token, "/api/sessions", "GET", undefined, c.signal).then((r) => r.json()),
      api(token, "/api/settings/call-logs", "GET", undefined, c.signal).then((r) => r.json()),
    ])
      .then(([items, sessionList, setting]: [CallSummary[], Session[], { enabled: boolean }]) => {
        if (c.signal.aborted) return;
        setSessions(sessionList);
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
    refresh({ path: usageListPath });
  }
  async function action(command: "download" | "filtered" | "toggle" | "clear") {
    if (
      command === "clear" &&
      !window.confirm("현재 저장된 호출 로그를 모두 비울까요? 대화 기록은 유지됩니다.")
    )
      return;
    setBusy(true);
    setError("");
    try {
      if (command === "download" || command === "filtered") {
        const path = "/api/call-logs/export";
        const response = command === "filtered"
          ? await api(token, path, "POST", { ids: visibleRows.map(row => row.id) })
          : await api(token, path);
        const prefix = command === "filtered" ? "AGS-calls-filtered" : "AGS-calls";
        download(await response.json(), `${prefix}-${new Date().toISOString().slice(0, 10)}.json`);
      } else if (command === "clear") {
        await api(token, "/api/call-logs", "DELETE");
        setRows([]);
        reload("");
      } else {
        const response = await api(token, "/api/settings/call-logs", "PUT", { enabled: !enabled });
        setEnabled((await response.json()).enabled);
      }
    } catch (e) {
      setError(
        {
          download: "로그를 내려받지 못했습니다.",
          filtered: e instanceof Error ? e.message : "필터 결과를 내려받지 못했습니다.",
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
            <LogFilter label="대화" options={sessionOptions} value={filters.session} change={v => changeFilter("session", v)} />
            <LogFilter label="공급자" options={providerNames} value={filters.provider} change={(v) => changeFilter("provider", v)} />
            <LogFilter label="모델 ID" options={modelOptions} value={filters.model} change={v => changeFilter("model", v)} />
            <LogFilter label="호출 종류" options={callKinds} value={filters.kind} change={(v) => changeFilter("kind", v)} />
            <LogFilter label="종료 상태" options={statuses} value={filters.status} change={(v) => changeFilter("status", v)} />
          </fieldset>
          {Object.values(filters).some(Boolean) && (
            <div>
              <output>{rows.length}건 중 {visibleRows.length}건</output>{" "}
              <button type="button" disabled={busy || loading || visibleRows.length === 0}
                onClick={() => void action("filtered")}>필터 결과 JSON 다운로드</button>{" "}
              <button type="button" onClick={() => {
                setId(selectedId ?? "");
                setFilters(emptyFilters);
              }}>필터 초기화</button>
            </div>
          )}
          <UsageTotals rows={visibleRows} />
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
      {selectedId && <CallDetail key={selectedId} id={selectedId} token={token} sessionTitle={selected?.session ? sessionById.get(selected.session)?.title : undefined} />}
    </div>
  );
}
