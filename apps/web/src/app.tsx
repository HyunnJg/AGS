import { CopyText } from "./CopyText.tsx";
import { WorkspaceReadDetails } from "./WorkspaceReadDetails.tsx";
import { DeleteConversation } from "./DeleteConversation.tsx";
import { ConversationSearch } from "./ConversationSearch.tsx";
import { ConversationTitle } from "./ConversationTitle.tsx";
import { ReviewEditor } from "./ReviewEditor.tsx";
import { CheckpointEditor } from "./CheckpointEditor.tsx";
import { staleStateMessage, memoryUseLabel } from "../../../packages/contracts/src/context.ts";
import { AttachedReferences, useFileReferences } from "./FileReferences.tsx";
import { ProjectWorkspace } from "./ProjectWorkspace.tsx";
import { ReplyText } from "./DisplayRules.tsx";
import type { DisplayRule } from "../../../packages/contracts/src/display.ts";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { turnStatusLabels, presets, isCustomPresetId, type CustomPresetSummary, type Preset, type Session, type Turn, type TurnSearchHit } from "../../../packages/contracts/src/sessions.ts";
import { api, chatEvents } from "./api.ts";
import {
  isModelSelection,
  providerNames,
  workspaceToolModes,
  type ProviderOption,
  type ModelSelection,
} from "../../../packages/contracts/src/providers.ts";
import { SettingsCenter } from "./SettingsCenter.tsx";
import "./style.css";

function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
function problem(e: unknown) {
  return e instanceof Error ? e.message : "잠시 후 다시 시도해 주세요.";
}

function Login({ enter }: { enter: (token: string) => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const value = token.trim();
      await api(value, "/api/sessions");
      sessionStorage.setItem("ags-token", value);
      enter(value);
    } catch (e) {
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <form onSubmit={connect}>
        <div className="brand">
          <Mark /> AI General Staff
        </div>
        <h1>작업실 연결</h1>
        <label htmlFor="token">로컬 인증 토큰</label>
        <input
          id="token"
          type="password"
          required
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <small>
          Windows 실행기로 시작했다면 Ctrl+V로 토큰을 붙여 넣으세요. 직접 시작했다면 설정한 AGS_LOCAL_TOKEN을
          입력하세요.
        </small>
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          작업실 열기
        </button>
      </form>
    </main>
  );
}

function Conversation({
  token,
  session,
  update,
  activity,
  favorites,
  customPresets,
  displayRules,
  options,
  onRemoteActivity,
  onReviewer,
  onDeleted,
  text,
  setText,
  draftUnsaved,
  searchHit,
  visible,
}: {
  token: string;
  session: Session;
  update: (s: Partial<Session> & Pick<Session, "id">, previousTitle?: string) => void;
  activity: (id: string, running: boolean) => void;
  visible: boolean;
  favorites: ModelSelection[];
  customPresets: CustomPresetSummary[];
  displayRules: DisplayRule[];
  options: ProviderOption[];
  onDeleted: (id: string) => void;
  onReviewer: (id: string, open?: boolean) => void;
  onRemoteActivity: (id: string, active: boolean) => void;
  text: string;
  setText: (value: string) => void;
  draftUnsaved: boolean;
  searchHit?: TurnSearchHit;
}) {
  const choices: ModelSelection[] = [];
  for (const option of options) {
    const models = new Set<string>();
    if (isModelSelection({ provider: option.id, model: option.defaultModel })) {
      models.add(option.defaultModel);
    }
    for (const pin of favorites) if (pin.provider === option.id) models.add(pin.model);
    if (session.provider === option.id) models.add(session.model);
    for (const model of models) choices.push({ provider: option.id, model });
  }
  const toolMode = workspaceToolModes[session.provider];
  const providerEnabled = options.some(option => option.id === session.provider && option.enabled);
  const reviewChoices = choices.filter(choice => options.some(o => o.id === choice.provider && o.enabled));
  const references = useFileReferences(token, session.id);
  const path = `/api/sessions/${session.id}`;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [readGrant, setReadGrant] = useState<{scope: string; folder: string}>();
  const [loadingGrant, setLoadingGrant] = useState(false);
  const grantRequest = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A grant must expire when the session changes scope.
  useEffect(() => {
    setReadGrant(undefined);
    setLoadingGrant(false);
    return () => grantRequest.current?.abort();
  }, [session.id, session.sectionRevision, session.provider, session.model]);
  async function toggleRead() {
    if (readGrant) return setReadGrant(undefined);
    const request = new AbortController();
    grantRequest.current = request;
    setLoadingGrant(true);
    try {
      const grant = await (await api(token, `${path}/workspace-read`, "GET", undefined, request.signal)).json();
      if (grant.provider !== session.provider || grant.model !== session.model || grant.sectionId !== session.sectionId ||
          grant.sectionRevision !== session.sectionRevision) throw new Error("대화 모델이나 소속이 바뀌었습니다. 새로고침 후 확인하세요.");
      if (!request.signal.aborted) setReadGrant(grant);
    } catch (e) {
      if (!request.signal.aborted) setError(problem(e));
    } finally {
      if (!request.signal.aborted) setLoadingGrant(false);
    }
  }
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingPreset, setSavingPreset] = useState(false);
  const [lastMemory, setLastMemory] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const visitedHit = useRef<TurnSearchHit | undefined>(undefined);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const draftVersion = useRef(0);
  function editDraft(value: string) {
    draftVersion.current++;
    setText(value);
  }
  function restoreQuestion(message: string) {
    if (text !== message && !text.endsWith(`\n\n${message}`)) {
      editDraft(text ? `${text}\n\n${message}` : message);
    }
    composerInput.current?.focus();
  }
  const remoteStreaming = !busy && turns.some((t) => t.status === "streaming");
  useEffect(() => {
    if (!remoteStreaming) return;
    onRemoteActivity(session.id, true);
    return () => onRemoteActivity(session.id, false);
  }, [remoteStreaming, session.id, onRemoteActivity]);
  useEffect(() => {
    let alive = true;
    async function read() {
      try {
        const data = await (await api(token, path)).json();
        if (alive && !sending.current) {
          setTurns(data.turns);
          setReady(true);
          if (searchHit && !data.turns.some((t: Turn) => t.id === searchHit.turnId)) {
            setError("검색한 턴을 찾을 수 없습니다. 본문을 다시 검색하세요.");
          }
        }
      } catch (e) {
        if (alive) setError(problem(e));
      }
    }
    void read();
    const timer = remoteStreaming ? setInterval(read, 600) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, token, remoteStreaming, searchHit]);
  useEffect(() => {
    if (!visible || !turns.length) return;
    if (searchHit) {
      const target = document.getElementById(`turn-${searchHit.turnId}`);
      if (visitedHit.current !== searchHit) {
        if (target) {
          target.focus({ preventScroll: true });
          target.scrollIntoView({ block: "start" });
          visitedHit.current = searchHit;
        }
        return;
      }
      if (target === document.activeElement) return;
    }
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, visible, searchHit]);

  async function changeSettings(value: { preset: Preset } | ModelSelection) {
    setSavingPreset(true);
    try {
      await api(token, path, "PATCH", value);
      update({ id: session.id, ...value });
      return true;
    } catch (e) {
      setError(problem(e));
      return false;
    } finally {
      setSavingPreset(false);
    }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message || loadingGrant || savingPreset || sending.current || remoteStreaming || !ready || !providerEnabled) return;
    const submittedVersion = draftVersion.current;
    sending.current = true;
    setBusy(true);
    activity(session.id, true);
    setError("");
    let accepted = false;
    try {
      const workspaceScope = session.sectionId && toolMode ? readGrant?.scope : undefined;
      setReadGrant(undefined);
      const r = await api(token, `${path}/chat`, "POST", { message, workspaceScope,
        ...(workspaceScope && toolMode === "share_root_list" && { workspaceShare: "openai_root_names" }) });
      accepted = true;
      const usage = r.headers.get("x-ags-memory-use");
      const label = usage ? memoryUseLabel(JSON.parse(usage)) : "";
      setLastMemory(
        label ? `${session.provider === "mock" ? "직전 입력 구성 (mock)" : "직전 전송"} · ${label}` : "",
      );
      if (r.headers.get("x-ags-section-state") === "stale") setError(staleStateMessage);
      const id = r.headers.get("x-request-id") ?? "";
      setPendingId(id);
      if (draftVersion.current === submittedVersion) setText("");
      setTurns((prev) => [
        ...prev,
        {
          id,
          message,
          reply: "",
          ...(workspaceScope && { workspaceReads: [] }),
          status: "streaming",
          preset: session.preset,
          provider: session.provider,
          model: session.model,
        },
      ]);
      for await (const event of chatEvents(r)) {
        if (event.type === "error") {
          const errors = {
            workspace_tool_budget: "폴더 목록으로 답변을 이어갈 예산이 부족합니다. 입력·출력 한도를 확인하세요.",
            workspace_read_failed: "작업 폴더 조회를 마치지 못했습니다. 작업 활동과 원본 파일을 확인하세요.",
            storage_failed: "대화 기록을 저장하지 못했습니다. 저장 공간을 확인하세요.",
            provider_auth: "공급자 API 키와 접근 권한을 확인하세요.",
            provider_limit: "공급자 요청 한도에 도달했습니다.",
            timeout: "응답 시간이 초과되었습니다.",
            provider_failed: workspaceScope && toolMode === "share_root_list"
              ? "OpenAI 도구 요청을 완료하지 못했습니다. 모델의 함수 호출 지원 여부와 호출 로그를 확인하세요."
              : "공급자 응답을 완료하지 못했습니다. 모델 ID와 서버 설정을 확인하세요.",
          };
          setError(errors[event.code]);
        }
        setTurns((prev) =>
          prev.map((t) => {
            if (t.id !== id) return t;
            if (event.type === "delta") return { ...t, reply: t.reply + event.text };
            return {
              ...t,
              status:
                event.type === "done" ? "completed" : event.type === "cancelled" ? "cancelled" : "failed",
            };
          }),
        );
      }
    } catch (e) {
      setError(problem(e));
    } finally {
      try {
        const data = await (await api(token, path)).json();
        update(data.session, session.title);
        setTurns(data.turns);
      } catch (e) {
        if (accepted)
          setTurns((prev) =>
            prev.map((t) => (t.status === "streaming" ? { ...t, status: "interrupted" } : t)),
          );
        setError(problem(e));
      }
      sending.current = false;
      setBusy(false);
      activity(session.id, false);
      setPendingId("");
    }
  }
  async function cancel() {
    try {
      await api(token, `/api/chat/${pendingId}/cancel`, "POST");
    } catch (e) {
      setError(problem(e));
    }
  }
  const [savingArchive, setSavingArchive] = useState(false);
  async function changeArchive() {
    const archived = !session.archived;
    setSavingArchive(true);
    setError("");
    try {
      await api(token, `${path}/archive`, "PUT", { archived });
      update({ id: session.id, archived });
    } catch (e) {
      setError(problem(e));
      try {
        const data = await (await api(token, path)).json();
        update({ id: session.id, archived: data.session.archived });
      } catch { /* Keep the original error visible. */ }
    } finally {
      setSavingArchive(false);
    }
  }
  const selectablePresets = customPresets.filter((item) => !item.archived || item.id === session.preset);
  return (
    <section className="conversation" hidden={!visible}>
      <header>
        <div className="conversation-title">
          {session.sectionLabel && <small>{session.sectionLabel}</small>}
          <ConversationTitle token={token} id={session.id} title={session.title}
            onTitle={title => update({ id: session.id, title })} />
          <button type="button" disabled={savingArchive || busy || remoteStreaming || !ready} onClick={() => void changeArchive()}>
            {session.archived ? "보관함에서 복원" : "대화 보관"}
          </button>
          {session.archived && <DeleteConversation token={token} id={session.id} onDeleted={onDeleted}
            onRestored={() => update({ id: session.id, archived: false })}
            disabled={savingArchive || busy || remoteStreaming || !ready} />}
        </div>
        <label className="preset">
          프리셋{" "}
          <select
            aria-label="프리셋"
            value={session.preset}
            disabled={busy || remoteStreaming || savingPreset || !ready}
            onChange={(e) => void changeSettings({ preset: e.target.value as Preset })}
          >
            {Object.entries(presets).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
            {isCustomPresetId(session.preset) && !customPresets.some((item) => item.id === session.preset) && (
              <option value={session.preset}>사용자 프리셋</option>
            )}
            {selectablePresets.length > 0 && <optgroup label="사용자 프리셋">
              {selectablePresets.map((item) => (
                <option key={item.id} value={item.id}>{item.name}{item.archived && " (보관됨)"}</option>
              ))}
            </optgroup>}
          </select>
        </label>
      </header>
      <div className="messages">
        <div className="column">
          {ready && !turns.length && (
            <div className="welcome">
              <Mark />
              <h1>무엇부터 시작할까요?</h1>
            </div>
          )}
          {turns.map((t) => (
            <article key={t.id} id={`turn-${t.id}`} tabIndex={-1}>
              <div className="user-message">{t.message}</div>
              <div className="byline">
                <Mark /> AGS{" "}
                <small>
                  {providerNames[t.provider]} {t.model}
                </small>
              </div>
              {t.workspaceReads && t.provider === "mock" ? <>
                <div className="reply">{t.reply}</div>
                {t.reply && t.status !== "streaming" && <CopyText label="답변 복사" text={t.reply} />}
              </> : <ReplyText text={t.reply} rules={displayRules} finished={t.status !== "streaming" && visible} />}
              {t.workspaceReads && <WorkspaceReadDetails reads={t.workspaceReads} />}
              {t.status !== "completed" && (
                <div className="turn-status">
                  <small className="status">{turnStatusLabels[t.status]}</small>
                  {t.status !== "streaming" && (
                    <button type="button" onClick={() => restoreQuestion(t.message)}>
                      {text ? "초안 끝에 질문 추가" : "질문 다시 편집"}
                    </button>
                  )}
                </div>
              )}
            </article>
          ))}
          <div ref={end} />
        </div>
      </div>
      <div className="composer">
        <ReviewEditor token={token} session={session}
          choices={reviewChoices} references={references.refs}
          turns={turns}
          insert={value=>editDraft(text ? `${text}\n\n${value}` : value)} onCreated={onReviewer} />
        {session.sectionId && <CheckpointEditor key={session.sectionRevision} token={token} session={session} />}
        {lastMemory && <small>{lastMemory}</small>}
        <AttachedReferences token={token} session={session.id} references={references} />
        {session.sectionId && toolMode && <div>
          <label className="match-case"><input type="checkbox" checked={!!readGrant}
            disabled={!providerEnabled || !ready || busy || remoteStreaming || loadingGrant || savingPreset}
            onChange={() => void toggleRead()} />{toolMode === "local" ? "이번 요청에서 작업 폴더 읽기 허용" : "이번 요청에서 최상위 폴더·문서 이름을 OpenAI에 공유 허용"}</label>
          {readGrant && <small>{readGrant.folder} · {toolMode === "local" ? "문구 검색은 “검색어”, 목록 조회는 폴더 목록 또는 폴더 목록 “자료”를 입력하세요." : "모델이 목록을 요청하면 이름을 전송합니다. OpenAI API 호출은 최대 2회입니다."}</small>}
        </div>}
        <form onSubmit={send}>
          <textarea
            ref={composerInput}
            disabled={!ready}
            aria-label="메시지"
            placeholder="메시지 입력"
            value={text}
            onChange={(e) => editDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {draftUnsaved && <small role="alert">초안을 탭에 저장하지 못했습니다. 새로고침 전에 복사해 두세요.</small>}
          {!providerEnabled && <small>{providerNames[session.provider]} 연결을 확인하거나 다른 모델을 선택하세요.</small>}
          <div className="actions">
            <select
              className="quick-model"
              aria-label="등록 모델 선택"
              title="공급자 기본 모델과 즐겨찾기"
              value={JSON.stringify([session.provider, session.model])}
              disabled={!ready || busy || remoteStreaming || savingPreset}
              onChange={(e) => {
                const [provider, model] = JSON.parse(e.target.value);
                void changeSettings({ provider, model });
              }}
            >
              {choices.map((choice) => (
                <option
                  key={JSON.stringify([choice.provider, choice.model])}
                  value={JSON.stringify([choice.provider, choice.model])}
                  disabled={!options.find((o) => o.id === choice.provider)?.enabled}
                >
                  {providerNames[choice.provider]}
                  {choice.model && ` · ${choice.model}`}
                </option>
              ))}
            </select>
            {busy ? (
              <button type="button" disabled={!pendingId} onClick={() => void cancel()}>
                ■ 중단
              </button>
            ) : (
              <button
                type="submit"
                className="primary"
                disabled={!ready || !text.trim() || remoteStreaming || savingPreset || !providerEnabled}
              >
                전송 ↑
              </button>
            )}
          </div>
        </form>
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}

type ChatDraft = { text: string; unsaved: boolean };

function restoreDrafts(sessions: Session[]) {
  const drafts: Record<string, ChatDraft> = {};
  try {
    const ids = new Set(sessions.map(s => s.id));
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("ags-draft:") && !ids.has(key.slice("ags-draft:".length))) sessionStorage.removeItem(key);
    }
    for (const { id } of sessions) {
      const text = sessionStorage.getItem(`ags-draft:${id}`);
      if (text) drafts[id] = { text, unsaved: false };
    }
  } catch { /* Keep the workspace usable if the browser refuses a draft read. */ }
  return drafts;
}

function sectionFields(current: Session, patch: Partial<Session>) {
  const latest = patch.sectionRevision !== undefined && patch.sectionRevision >= (current.sectionRevision ?? 0) ? patch : current;
  return { sectionId: latest.sectionId, sectionLabel: latest.sectionLabel, sectionRevision: latest.sectionRevision };
}

function Workspace({ token }: { token: string }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sectionFilter, setSectionFilter] = useState("");
  const sectionOptions = useMemo(() => {
    const sections = new Map<string, string>();
    for (const session of sessions) {
      if (session.sectionId && session.sectionLabel) sections.set(session.sectionId, session.sectionLabel);
    }
    return [...sections].sort(([, a], [, b]) => a.localeCompare(b, "ko"));
  }, [sessions]);
  useEffect(() => {
    if (sectionFilter && sectionFilter !== "unassigned" && !sectionOptions.some(([id]) => id === sectionFilter)) {
      setSectionFilter("");
    }
  }, [sectionOptions, sectionFilter]);
  const terms = sessionQuery.trim().normalize("NFC").toLowerCase().split(/\s+/).filter(Boolean);
  const [showArchived, setShowArchived] = useState(false);
  const visibleSessions = sessions.filter(session => {
    if (Boolean(session.archived) !== showArchived) return false;
    if (sectionFilter && (session.sectionId ?? "unassigned") !== sectionFilter) return false;
    const searchable = [session.title, session.sectionLabel, providerNames[session.provider], session.provider, session.model]
      .join(" ").normalize("NFC").toLowerCase();
    return terms.every(term => searchable.includes(term));
  });
  const [id, setId] = useState("");
  const [searchHit, setSearchHit] = useState<TurnSearchHit>();
  const [sessionsReady, setSessionsReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  const [options, setOptions] = useState<ProviderOption[]>([]);
  const ready = sessionsReady && options.length > 0;
  const [drafts, setDrafts] = useState<Record<string, ChatDraft>>({});
  function saveDraft(id: string, text: string) {
    const key = `ags-draft:${id}`;
    let unsaved = false;
    try {
      if (text) sessionStorage.setItem(key, text);
      else sessionStorage.removeItem(key);
    } catch {
      unsaved = true;
      // If the new text exceeds quota, do not restore an older version on reload.
      try { sessionStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
    }
    setDrafts(prev => ({ ...prev, [id]: { text, unsaved } }));
  }
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [displayRules, setDisplayRules] = useState<DisplayRule[]>([]);
  const [customPresets, setCustomPresets] = useState<CustomPresetSummary[]>([]);
  const [favorites, setFavorites] = useState<ModelSelection[]>([]);
  useEffect(() => {
    if (settings) return;
    let pending: AbortController | undefined;
    const reload = () => {
      pending?.abort();
      pending = new AbortController();
      const { signal } = pending;
      async function read<T>(path: string, update: (value: T) => void) {
        try {
          const response = await api(token, path, "GET", undefined, signal);
          const data: T = await response.json();
          if (!signal.aborted) update(data);
        } catch (e) {
          if (!signal.aborted) setError(problem(e));
        }
      }
      void read<ProviderOption[]>("/api/providers", setOptions);
      void read<CustomPresetSummary[]>("/api/settings/presets?includeArchived=1", setCustomPresets);
      void read<ModelSelection[]>("/api/settings/favorites", setFavorites);
      void read<{ rules: DisplayRule[] }>("/api/settings/display-rules", ({ rules }) => {
        setDisplayRules((prev) => JSON.stringify(prev) === JSON.stringify(rules) ? prev : rules);
      });
    };
    reload();
    window.addEventListener("focus", reload);
    return () => {
      pending?.abort();
      window.removeEventListener("focus", reload);
    };
  }, [token, settings]);
  const currentSession = sessions.find((s) => s.id === id);
  const [remoteId, setRemoteId] = useState("");
  const onRemoteActivity = useCallback(
    (key: string, active: boolean) =>
      setRemoteId((previous) => (active ? key : previous === key ? "" : previous)),
    [],
  );
  const [running, setRunning] = useState<string[]>([]);
  const activity = (key: string, active: boolean) =>
    setRunning((prev) => (active ? [...prev, key] : prev.filter((item) => item !== key)));
  const mounted = ready ? sessions.filter((s) => s.id === id || running.includes(s.id)) : [];
  const select = useCallback((id: string, keepSearch = false, hit?: TurnSearchHit) => {
    setSearchHit(hit ? { ...hit } : undefined);
    if (!keepSearch) {
      setSessionQuery("");
      setSectionFilter("");
    }
    setId(id);
    sessionStorage.setItem("ags-session", id);
  }, []);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows: Session[] = await (await api(token, "/api/sessions")).json();
        if (alive) {
          setDrafts(restoreDrafts(rows));
          setSessions(rows);
          select(rows.find((s) => s.id === sessionStorage.getItem("ags-session"))?.id ?? rows.find(s => !s.archived)?.id ?? "");
          setSessionsReady(true);
        }
      } catch (e) {
        if (alive) setError(problem(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, select]);
  const deletedChannel = useRef<BroadcastChannel | null>(null);
  const forgetSession = useCallback((deleted: string) => {
    try { sessionStorage.removeItem(`ags-draft:${deleted}`); } catch { /* Storage may be unavailable. */ }
    setSessions(prev => prev.filter(s => s.id !== deleted));
    setDrafts(prev => {
      const next = { ...prev };
      delete next[deleted];
      return next;
    });
  }, []);
  useEffect(() => {
    const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("ags-deleted-sessions") : null;
    deletedChannel.current = channel;
    if (channel) channel.onmessage = event => {
      if (typeof event.data === "string") forgetSession(event.data);
    };
    const missing = (event: Event) => forgetSession((event as CustomEvent<string>).detail);
    window.addEventListener("ags-session-missing", missing);
    return () => {
      window.removeEventListener("ags-session-missing", missing);
      deletedChannel.current = null;
      channel?.close();
    };
  }, [forgetSession]);
  useEffect(() => {
    if (!sessionsReady || !id || sessions.some(s => s.id === id)) return;
    const next = sessions.find(s => Boolean(s.archived) === showArchived) ?? sessions[0];
    setShowArchived(Boolean(next?.archived));
    select(next?.id ?? "");
  }, [sessionsReady, id, sessions, showArchived, select]);
  async function create() {
    setLocked(true);
    try {
      const session: Session = await (await api(token, "/api/sessions", "POST")).json();
      setSessions((prev) => [session, ...prev]);
      setShowArchived(false);
      select(session.id);
      setError("");
    } catch (e) {
      setError(problem(e));
    } finally {
      setLocked(false);
    }
  }
  async function applyModel(selection: ModelSelection) {
    if (currentSession) {
      const changed: Session = await (
        await api(token, `/api/sessions/${currentSession.id}`, "PATCH", selection)
      ).json();
      setSessions((prev) => prev.map((s) => (s.id === changed.id ? { ...s, provider: changed.provider, model: changed.model } : s)));
    } else {
      const created: Session = await (await api(token, "/api/sessions", "POST", selection)).json();
      setSessions((prev) => [created, ...prev]);
      select(created.id);
    }
  }
  return (
    <main className={projectsOpen ? "layout with-workspace" : "layout"}>
      <aside>
        <div className="brand">
          <Mark />
          <span>AI General Staff</span>
        </div>
        <button type="button" className="new" disabled={locked || !ready} onClick={() => void create()}>
          ＋ 새 대화
        </button>
        <button
          type="button"
          className="project-launcher"
          aria-expanded={projectsOpen}
          aria-controls="project-workspace"
          disabled={!ready}
          onClick={() => setProjectsOpen((open) => !open)}
        >
          프로젝트 · 파일
        </button>
        <h2 className="nav-label">대화 목록</h2>
        {sessions.length > 0 && (
          <input
            className="session-search"
            type="search"
            aria-label="대화 목록 검색"
            placeholder="제목 · 섹션 · 모델 검색"
            value={sessionQuery}
            onChange={e => setSessionQuery(e.target.value)}
          />
        )}
        {sectionOptions.length > 0 && (
          <select className="session-section-filter" aria-label="대화 목록 섹션" value={sectionFilter}
            onChange={e => setSectionFilter(e.target.value)}>
            <option value="">전체 섹션</option>
            <option value="unassigned">미소속 대화</option>
            {sectionOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        )}
        {ready && <ConversationSearch token={token} openHit={async (hit, close, signal) => {
          // Another tab may have created the conversation since this sidebar loaded.
          if (!sessions.some(s => s.id === hit.sessionId)) {
            const rows: Session[] = await (await api(token, "/api/sessions", "GET", undefined, signal)).json();
            const session = rows.find(s => s.id === hit.sessionId);
            if (signal.aborted) return;
            if (!session) throw new Error("검색한 대화를 찾을 수 없습니다.");
            setSessions(prev => prev.some(s => s.id === session.id) ? prev : [session, ...prev]);
          }
          close();
          select(hit.sessionId, false, hit);
        }} />}
        {(showArchived || sessions.some(s => s.archived)) && <button type="button" className="archive-list"
          aria-pressed={showArchived} onClick={() => setShowArchived(value => !value)}>
          {showArchived ? "일반 대화 보기" : "보관함 보기"}
        </button>}
        <nav aria-label="대화 목록">
          {(terms.length > 0 || sectionFilter || showArchived) && visibleSessions.length === 0 && <output>일치하는 대화가 없습니다.</output>}
          {visibleSessions.map((s) => (
            <button
              type="button"
              key={s.id}
              disabled={locked}
              aria-current={s.id === id ? "page" : undefined}
              onClick={() => select(s.id, true)}
            >
              {s.title}
              {running.includes(s.id) && <small> · 응답 중</small>}
              {terms.length > 0 && <small className="session-match-detail">
                {[s.sectionLabel, providerNames[s.provider], s.model].filter(Boolean).join(" · ")}
              </small>}
            </button>
          ))}
        </nav>
        {error && <p role="alert">{error}</p>}
        <button
          type="button"
          className="settings-launcher"
          disabled={!ready || locked}
          onClick={() => setSettings(true)}
        >
          설정
        </button>
      </aside>
      {projectsOpen && (
        <ProjectWorkspace
          token={token}
          current={currentSession}
          streaming={running.includes(id) || Boolean(id && remoteId === id)}
          onSectionChanged={linked => setSessions(prev => prev.map(s => s.id === linked.id
            ? { ...s, ...sectionFields(s, linked) } : s))}
          sessions={sessions}
          close={() => setProjectsOpen(false)}
          openSession={(s) => {
            setSessions((prev) => (prev.some((item) => item.id === s.id) ? prev : [s, ...prev]));
            select(s.id);
            if (!window.matchMedia("(min-width: 1000px)").matches) setProjectsOpen(false);
          }}
        />
      )}
      {settings && (
        <SettingsCenter
          token={token}
          selection={currentSession ?? { provider: "mock", model: "" }}
          session={currentSession}
          draft={drafts[id]?.text ?? ""}
          streaming={running.includes(id) || Boolean(id && remoteId === id)}
          options={options}
          close={() => setSettings(false)}
          onOptions={setOptions}
          onRulesSaved={setDisplayRules}
          save={applyModel}
        />
      )}
      {mounted.length ? (
        mounted.map((current) => (
          <Conversation
            key={current.id}
            token={token}
            session={current}
            activity={activity}
            searchHit={searchHit?.sessionId === current.id ? searchHit : undefined}
            visible={current.id === id}
            text={drafts[current.id]?.text ?? ""}
            draftUnsaved={drafts[current.id]?.unsaved ?? false}
            setText={value => saveDraft(current.id, value)}
            onDeleted={deleted => {
              forgetSession(deleted);
              deletedChannel.current?.postMessage(deleted);
            }}
            onReviewer={async (reviewer, open) => {
              try {
                const data = await (await api(token,`/api/sessions/${reviewer}`)).json();
                setSessions(prev => {
                  const existing = prev.find(s => s.id === reviewer);
                  const next = existing ? { ...data.session, ...sectionFields(existing, data.session) } : data.session;
                  return [next, ...prev.filter(s => s.id !== reviewer)];
                });
                if (open) select(reviewer);
              } catch (e) { setError(problem(e)); }
            }}
            onRemoteActivity={onRemoteActivity}
            displayRules={displayRules}
            favorites={favorites}
            customPresets={customPresets}
            options={options}
            update={(patch, previousTitle) => setSessions(prev => prev.map(item => {
              if (item.id !== patch.id) return item;
              // A chat refresh can arrive after an explicit rename has already succeeded.
              const title = previousTitle === undefined || previousTitle === item.title ? patch.title : item.title;
              return { ...item, ...patch, ...sectionFields(item, patch), title: title ?? item.title };
            }))}
          />
        ))
      ) : (
        <section className="empty">
          <Mark />
          <h1>작업실</h1>
          <button type="button" className="primary" disabled={!ready || locked} onClick={() => void create()}>
            첫 대화 시작
          </button>
        </section>
      )}
    </main>
  );
}
function App() {
  const [token, setToken] = useState(sessionStorage.getItem("ags-token") ?? "");
  useEffect(() => {
    const reset = () => setToken("");
    window.addEventListener("ags-unauthorized", reset);
    return () => window.removeEventListener("ags-unauthorized", reset);
  }, []);
  return token ? <Workspace token={token} /> : <Login enter={setToken} />;
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
