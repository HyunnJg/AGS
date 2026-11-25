import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { presets, type Preset, type Session, type Turn } from "../../../packages/contracts/src/sessions.ts";
import { api, chatEvents } from "./api.ts";
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
        <small>서버를 시작할 때 설정한 AGS_LOCAL_TOKEN을 입력하세요.</small>
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
  lock,
  locked,
}: {
  token: string;
  session: Session;
  update: (s: Session) => void;
  lock: (v: boolean) => void;
  locked: boolean;
}) {
  const path = `/api/sessions/${session.id}`;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingPreset, setSavingPreset] = useState(false);
  const [pendingId, setPendingId] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const remoteStreaming = !busy && turns.some((t) => t.status === "streaming");
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
    if (turns.length) end.current?.scrollIntoView({ block: "nearest" });
  }, [turns]);

  async function changePreset(value: Preset) {
    setSavingPreset(true);
    try {
      update(await (await api(token, path, "PATCH", { preset: value })).json());
    } catch (e) {
      setError(problem(e));
    } finally {
      setSavingPreset(false);
    }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message || locked || savingPreset || sending.current || remoteStreaming || !ready) return;
    sending.current = true;
    setBusy(true);
    lock(true);
    setError("");
    let accepted = false;
    try {
      const r = await api(token, `${path}/chat`, "POST", { message });
      accepted = true;
      const id = r.headers.get("x-request-id") ?? "";
      setPendingId(id);
      setText("");
      setTurns((prev) => [...prev, { id, message, reply: "", status: "streaming", preset: session.preset }]);
      for await (const event of chatEvents(r)) {
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
      lock(false);
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
    <section className="conversation">
      <header>
        <h2>{session.title}</h2>
        <label className="preset">
          프리셋{" "}
          <select
            aria-label="프리셋"
            value={session.preset}
            disabled={locked || remoteStreaming || savingPreset || !ready}
            onChange={(e) => void changePreset(e.target.value as Preset)}
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
                <Mark /> AGS <small>MOCK</small>
              </div>
              <div className="reply">{t.reply}</div>
              {statusLabels[t.status] && <small className="status">{statusLabels[t.status]}</small>}
            </article>
          ))}
          <div ref={end} />
        </div>
      </div>
      <div className="composer">
        <form onSubmit={send}>
          <textarea
            disabled={!ready || (locked && !busy)}
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
            <small>
              <span className="dot" /> 로컬 mock
            </small>
            {busy ? (
              <button type="button" disabled={!pendingId} onClick={() => void cancel()}>
                ■ 중단
              </button>
            ) : (
              <button
                type="submit"
                className="primary"
                disabled={!ready || locked || !text.trim() || remoteStreaming || savingPreset}
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
  const current = sessions.find((s) => s.id === id);
  const select = useCallback((id: string) => {
    setId(id);
    sessionStorage.setItem("ags-session", id);
  }, []);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows: Session[] = await (await api(token, "/api/sessions")).json();
        if (alive) {
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
  return (
    <main className="layout">
      <aside>
        <div className="brand">
          <Mark />
          <span>AI General Staff</span>
        </div>
        <button type="button" className="new" disabled={locked || !ready} onClick={() => void create()}>
          ＋ 새 대화
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
            </button>
          ))}
        </nav>
        {error && <p role="alert">{error}</p>}
      </aside>
      {current ? (
        <Conversation
          key={current.id}
          token={token}
          session={current}
          lock={setLocked}
          locked={locked}
          update={(s) => setSessions((prev) => prev.map((item) => (item.id === s.id ? s : item)))}
        />
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
