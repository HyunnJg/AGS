import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  DirectoryPage,
  FilePage,
  Project,
  WorkspaceCatalog,
} from "../../../packages/contracts/src/workspace.ts";
import type { Session } from "../../../packages/contracts/src/sessions.ts";
import { api } from "./api.ts";

function message(e: unknown) {
  return e instanceof Error ? e.message : "작업공간을 열 수 없습니다.";
}
function NameForm({ label, save }: { label: string; save: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await save(name.trim());
      setName("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <label>
        {label} 이름
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="submit" disabled={busy || !name.trim()}>
        {label} 만들기
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
type View = { path: string; folder: boolean; position: number };
const top: View = { path: "", folder: true, position: 0 };
function FileBrowser({ token, project }: { token: string; project: Project }) {
  const [view, setView] = useState(top);
  const [data, setData] = useState<{ view: View; dir?: DirectoryPage; file?: FilePage; error?: string }>();
  const [line, setLine] = useState("1");
  useEffect(() => {
    let current = true;
    const key = view.folder ? "entries" : "file";
    api(token, `/api/projects/${project.id}/${key}`, "POST", {
      root: project.root,
      path: view.path,
      ...(view.folder ? { offset: view.position } : { start: view.position }),
    })
      .then((r) => r.json())
      .then((result) => {
        if (current) setData(view.folder ? { view, dir: result } : { view, file: result });
      })
      .catch((e) => {
        if (current) setData({ view, error: message(e) });
      });
    return () => {
      current = false;
    };
  }, [project.id, token, view, project.root]);
  const result = data?.view === view ? data : undefined;
  const nextOffset = result?.dir?.next;
  const enter = (path: string, folder: boolean) => {
    setView({ path, folder, position: folder ? 0 : 1 });
    setLine("1");
  };
  const jump = (position: number) => {
    setView({ ...view, position });
    setLine(String(position));
  };
  return (
    <section className="file-browser" aria-label="작업 파일">
      <header>
        <strong>{view.path || "작업 폴더"}</strong>
        {view.path && (
          <button type="button" onClick={() => enter(view.path.split("/").slice(0, -1).join("/"), true)}>
            상위 폴더
          </button>
        )}
      </header>
      {!result && <output>불러오는 중…</output>}
      {result?.error && (
        <>
          <p role="alert">{result.error}</p>
          <button type="button" onClick={() => setView({ ...view })}>
            다시 읽기
          </button>
        </>
      )}
      {result?.dir && (
        <>
          <ul>
            {result.dir.entries.map((e) => (
              <li key={e.name}>
                <button
                  type="button"
                  onClick={() => enter([view.path, e.name].filter(Boolean).join("/"), e.kind === "folder")}
                >
                  {e.name}
                  {e.kind === "folder" ? "/" : ""}
                </button>
              </li>
            ))}
          </ul>
          {!result.dir.entries.length && <small>표시할 항목이 없습니다.</small>}
          {view.position > 0 && (
            <button type="button" onClick={() => jump(Math.max(0, view.position - 100))}>
              이전 목록
            </button>
          )}
          {nextOffset != null && (
            <button type="button" onClick={() => jump(nextOffset)}>
              다음 목록
            </button>
          )}
        </>
      )}
      {result?.file && (
        <>
          <small>
            {result.file.total
              ? `${result.file.start}–${result.file.end} / ${result.file.total}줄`
              : "빈 파일"}
          </small>
          <pre>{result.file.text}</pre>
          {result.file.clipped && <small>긴 줄은 앞 2,048자까지 표시합니다.</small>}
          {result.file.total > 0 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                jump(Number(line));
              }}
            >
              <label>
                시작 줄
                <input
                  type="number"
                  required
                  min="1"
                  max={result.file.total}
                  value={line}
                  onChange={(e) => setLine(e.target.value)}
                />
              </label>
              <button type="submit">줄 이동</button>
              {result.file.start > 1 && (
                <button type="button" onClick={() => jump(Math.max(1, view.position - 80))}>
                  이전 줄
                </button>
              )}
              {result.file.end < result.file.total && (
                <button type="button" onClick={() => jump(view.position + 80)}>
                  다음 줄
                </button>
              )}
            </form>
          )}
        </>
      )}
    </section>
  );
}
function ProjectFolder({
  token,
  project,
  refresh,
}: {
  token: string;
  project: Project;
  refresh: (id: string) => Promise<void>;
}) {
  const [path, setPath] = useState(project.root ?? "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function link(path: string | null) {
    setBusy(true);
    setError("");
    try {
      await api(token, `/api/projects/${project.id}/root`, "PUT", { path, previous: project.root });
      await refresh(project.id);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <details open={!project.root}>
        <summary>{project.root ? "연결 폴더 변경" : "작업 폴더 연결"}</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void link(path);
          }}
        >
          <label>
            작업 폴더 절대 경로
            <input required value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
          <button type="submit" disabled={busy || !path.trim()}>
            읽기 전용 연결
          </button>
          {project.root && (
            <button disabled={busy} type="button" onClick={() => void link(null)}>
              연결 해제
            </button>
          )}
        </form>
        {error && <p role="alert">{error}</p>}
      </details>
      {project.root && <FileBrowser token={token} project={project} />}
    </>
  );
}

export function ProjectWorkspace({
  token,
  sessions,
  current,
  close,
  openSession,
}: {
  token: string;
  sessions: Session[];
  current?: Session | undefined;
  close: () => void;
  openSession: (session: Session) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [catalog, setCatalog] = useState<WorkspaceCatalog>();
  const [projectId, setProject] = useState(""),
    [sectionId, setSection] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const route = "/api/projects";
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  useEffect(() => {
    let alive = true;
    api(token, route)
      .then((r) => r.json())
      .then((data: WorkspaceCatalog) => {
        if (!alive) return;
        const selected = data.sections.find((s) => s.id === current?.sectionId);
        setCatalog(data);
        setProject(selected?.projectId ?? sessionStorage.getItem("ags-project") ?? "");
        setSection(selected?.id ?? "");
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [token, current?.sectionId]);
  const project = catalog?.projects.find((p) => p.id === projectId) ?? catalog?.projects[0];
  const sections = catalog?.sections.filter((s) => s.projectId === project?.id) ?? [];
  const section = sections.find((s) => s.id === sectionId) ?? sections[0];
  function choose(id: string) {
    setProject(id);
    setSection("");
    sessionStorage.setItem("ags-project", id);
  }
  async function refresh(id: string) {
    const data = await (await api(token, route)).json();
    setCatalog(data);
    if (id !== project?.id) choose(id);
  }
  async function createSession() {
    if (!section || busy) return;
    setBusy(true);
    setError("");
    try {
      const session = await (await api(token, "/api/sessions", "POST", { sectionId: section.id })).json();
      openSession(session);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="settings-center project-workspace"
      aria-labelledby="workspace-heading"
      onCancel={close}
    >
      <header>
        <h2 id="workspace-heading">프로젝트 · 파일</h2>
        <button type="button" aria-label="작업공간 닫기" onClick={close}>
          닫기
        </button>
      </header>
      <div className="project-body">
        {error && <p role="alert">{error}</p>}
        {!catalog && !error && <small>불러오는 중…</small>}
        {catalog && (
          <>
            {!!catalog.projects.length && (
              <label>
                프로젝트 선택
                <select value={project?.id} onChange={(e) => choose(e.target.value)}>
                  {catalog.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <details
              key={catalog.projects.length === 0 ? "initial" : "existing"}
              open={!catalog.projects.length}
            >
              <summary>새 프로젝트</summary>
              <NameForm
                label="프로젝트"
                save={async (name) => {
                  const p = await (await api(token, route, "POST", { name })).json();
                  await refresh(p.id);
                }}
              />
            </details>
          </>
        )}
        {project && (
          <section key={project.id}>
            <label>
              섹션 선택
              <select value={section?.id} onChange={(e) => setSection(e.target.value)}>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <details>
              <summary>새 섹션</summary>
              <NameForm
                label="섹션"
                save={async (name) => {
                  const s = await (
                    await api(token, `${route}/${project.id}/sections`, "POST", { name })
                  ).json();
                  await refresh(project.id);
                  setSection(s.id);
                }}
              />
            </details>
            <div className="section-sessions">
              <button className="primary" type="button" disabled={busy} onClick={() => void createSession()}>
                섹션에서 새 대화
              </button>
              {sessions
                .filter((s) => s.sectionId === section?.id)
                .map((s) => (
                  <button type="button" key={s.id} onClick={() => openSession(s)}>
                    {s.title}
                  </button>
                ))}
            </div>
            <ProjectFolder key={project.root ?? ""} token={token} project={project} refresh={refresh} />
          </section>
        )}
      </div>
    </dialog>
  );
}
