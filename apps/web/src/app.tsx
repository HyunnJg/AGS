import { ReviewEditor } from "./ReviewEditor.tsx";
import { CheckpointEditor } from "./CheckpointEditor.tsx";
import { staleStateMessage, memoryUseLabel } from "../../../packages/contracts/src/context.ts";
import { AttachedReferences, useFileReferences } from "./FileReferences.tsx";
import { ProjectWorkspace } from "./ProjectWorkspace.tsx";
import { ReplyText } from "./DisplayRules.tsx";
import type { DisplayRule } from "../../../packages/contracts/src/display.ts";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { presets, type Preset, type Session, type Turn } from "../../../packages/contracts/src/sessions.ts";
import { api, chatEvents } from "./api.ts";
import {
  providerNames,
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

const statusLabels = {
  streaming: "응답 중",
  completed: "",
  cancelled: "중단됨",
  failed: "응답 실패",
  interrupted: "연결 종료로 중단됨",
};

function Conversation({
  token,
  session,
  update,
  activity,
  favorites,
  displayRules,
  options,
  onRemoteActivity,
  onReviewer,
  text,
  setText,
  visible,
}: {
  token: string;
  session: Session;
  update: (s: Session) => void;
  activity: (id: string, running: boolean) => void;
  visible: boolean;
  favorites: ModelSelection[];
  displayRules: DisplayRule[];
  options: ProviderOption[];
  onReviewer: (id: string, open?: boolean) => void;
  onRemoteActivity: (id: string, active: boolean) => void;
  text: string;
  setText: (value: string) => void;
}) {
  const choices: ModelSelection[] = [{ provider: "mock", model: "" }, ...favorites];
  if (!choices.some((c) => c.provider === session.provider && c.model === session.model))
    choices.push(session);
  const reviewChoices = choices.filter(choice => options.some(o => o.id === choice.provider && o.enabled));
  for (const o of options) {
    if (o.enabled && o.defaultModel && !reviewChoices.some(c => c.provider === o.id && c.model === o.defaultModel))
      reviewChoices.push({ provider: o.id, model: o.defaultModel });
  }
  const references = useFileReferences(token, session.id);
  const path = `/api/sessions/${session.id}`;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingPreset, setSavingPreset] = useState(false);
  const [lastMemory, setLastMemory] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
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
  }, [path, token, remoteStreaming]);
  useEffect(() => {
    if (visible && turns.length) end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, visible]);

  async function changeSettings(value: { preset: Preset } | ModelSelection) {
    setSavingPreset(true);
    try {
      update(await (await api(token, path, "PATCH", value)).json());
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
    if (!message || savingPreset || sending.current || remoteStreaming || !ready) return;
    sending.current = true;
    setBusy(true);
    activity(session.id, true);
    setError("");
    let accepted = false;
    try {
      const r = await api(token, `${path}/chat`, "POST", { message });
      accepted = true;
      const usage = r.headers.get("x-ags-memory-use");
      const label = usage ? memoryUseLabel(JSON.parse(usage)) : "";
      setLastMemory(
        label ? `${session.provider === "mock" ? "직전 입력 구성 (mock)" : "직전 전송"} · ${label}` : "",
      );
      if (r.headers.get("x-ags-section-state") === "stale") setError(staleStateMessage);
      const id = r.headers.get("x-request-id") ?? "";
      setPendingId(id);
      setText("");
      setTurns((prev) => [
        ...prev,
        {
          id,
          message,
          reply: "",
          status: "streaming",
          preset: session.preset,
          provider: session.provider,
          model: session.model,
        },
      ]);
      for await (const event of chatEvents(r)) {
        if (event.type === "error") {
          const errors = {
            storage_failed: "대화 기록을 저장하지 못했습니다. 저장 공간을 확인하세요.",
            provider_auth: "공급자 API 키와 접근 권한을 확인하세요.",
            provider_limit: "공급자 요청 한도에 도달했습니다.",
            timeout: "응답 시간이 초과되었습니다.",
            provider_failed: "공급자 응답을 완료하지 못했습니다. 모델 ID와 서버 설정을 확인하세요.",
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
        update(data.session);
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
  return (
    <section className="conversation" hidden={!visible}>
      <header>
        <div className="conversation-title">
          {session.sectionLabel && <small>{session.sectionLabel}</small>}
          <h2>{session.title}</h2>
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
            <article key={t.id}>
              <div className="user-message">{t.message}</div>
              <div className="byline">
                <Mark /> AGS{" "}
                <small>
                  {providerNames[t.provider]} {t.model}
                </small>
              </div>
              <ReplyText text={t.reply} rules={displayRules} finished={t.status !== "streaming" && visible} />
              {statusLabels[t.status] && <small className="status">{statusLabels[t.status]}</small>}
            </article>
          ))}
          <div ref={end} />
        </div>
      </div>
      <div className="composer">
        <ReviewEditor token={token} session={session}
          choices={reviewChoices} references={references.refs}
          lastReply={turns.findLast(t=>t.status==="completed")?.reply ?? ""}
          insert={value=>setText(text ? `${text}\n\n${value}` : value)} onCreated={onReviewer} />
        {session.sectionId && <CheckpointEditor token={token} session={session} />}
        {lastMemory && <small>{lastMemory}</small>}
        <AttachedReferences token={token} session={session.id} references={references} />
        <form onSubmit={send}>
          <textarea
            disabled={!ready}
            aria-label="메시지"
            placeholder="메시지 입력"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="actions">
            <select
              className="quick-model"
              aria-label="등록 모델 선택"
              title="설정에서 별표로 등록한 모델"
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
                disabled={!ready || !text.trim() || remoteStreaming || savingPreset}
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

function Workspace({ token }: { token: string }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [id, setId] = useState("");
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  const [options, setOptions] = useState<ProviderOption[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [displayRules, setDisplayRules] = useState<DisplayRule[]>([]);
  const [favorites, setFavorites] = useState<ModelSelection[]>([]);
  useEffect(() => {
    if (settings) return;
    let alive = true;
    const reload = () => {
      api(token, "/api/settings/display-rules")
        .then((r) => r.json())
        .then((data) => {
          if (alive)
            setDisplayRules((prev) =>
              JSON.stringify(prev) === JSON.stringify(data.rules) ? prev : data.rules,
            );
        })
        .catch((e) => {
          if (alive) setError(problem(e));
        });
      api(token, "/api/settings/favorites")
        .then((r) => r.json())
        .then((rows) => {
          if (alive) setFavorites(rows);
        })
        .catch((e) => {
          if (alive) setError(problem(e));
        });
    };
    reload();
    window.addEventListener("focus", reload);
    return () => {
      alive = false;
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
  const mounted = sessions.filter((s) => s.id === id || running.includes(s.id));
  const select = useCallback((id: string) => {
    setId(id);
    sessionStorage.setItem("ags-session", id);
  }, []);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [rows, choices]: [Session[], ProviderOption[]] = await Promise.all([
          api(token, "/api/sessions").then((r) => r.json()),
          api(token, "/api/providers").then((r) => r.json()),
        ]);
        if (alive) {
          setOptions(choices);
          setSessions(rows);
          select(rows.find((s) => s.id === sessionStorage.getItem("ags-session"))?.id ?? rows[0]?.id ?? "");
          setReady(true);
        }
      } catch (e) {
        if (alive) setError(problem(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, select]);
  async function create() {
    setLocked(true);
    try {
      const session: Session = await (await api(token, "/api/sessions", "POST")).json();
      setSessions((prev) => [session, ...prev]);
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
      setSessions((prev) => prev.map((s) => (s.id === changed.id ? changed : s)));
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
        <nav aria-label="대화 목록">
          {sessions.map((s) => (
            <button
              type="button"
              key={s.id}
              disabled={locked}
              aria-current={s.id === id ? "page" : undefined}
              onClick={() => select(s.id)}
            >
              {s.title}
              {running.includes(s.id) && <small> · 응답 중</small>}
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
          draft={drafts[id] ?? ""}
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
            visible={current.id === id}
            text={drafts[current.id] ?? ""}
            setText={(value) => setDrafts((prev) => ({ ...prev, [current.id]: value }))}
            onReviewer={async (reviewer, open) => {
              try {
                const data = await (await api(token,`/api/sessions/${reviewer}`)).json();
                setSessions(prev => [data.session,...prev.filter(s=>s.id!==reviewer)]);
                if (open) select(reviewer);
              } catch (e) { setError(problem(e)); }
            }}
            onRemoteActivity={onRemoteActivity}
            displayRules={displayRules}
            favorites={favorites}
            options={options}
            update={(s) => setSessions((prev) => prev.map((item) => (item.id === s.id ? s : item)))}
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
