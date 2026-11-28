import { SectionStateSource } from "./SectionMemory.tsx";
import { FileWrite } from "./FileWrite.tsx";
import { AttachLines } from "./FileReferences.tsx";
import { WorkspaceActivity } from "./WorkspaceActivity.tsx";
import { WorkspaceSearch } from "./WorkspaceSearch.tsx";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  DirectoryPage,
  FilePage,
  Section,
  Project,
  WorkspaceCatalog,
} from "../../../packages/contracts/src/workspace.ts";
import type { Session } from "../../../packages/contracts/src/sessions.ts";
import { api, SearchResultChanged } from "./api.ts";

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
type View = {
  path: string;
  folder: boolean;
  position: number;
  end?: number;
  version?: string;
  excerpt?: string;
};
const top: View = { path: "", folder: true, position: 0 };
function FileBrowser({
  token,
  project,
  current,
  section,
  refresh,
  knowledge = false,
  active = true,
}: {
  knowledge?: boolean;
  active?: boolean;
  section: Section;
  refresh: (id: string) => Promise<void>;
  token: string;
  project: Project;
  current: Session | undefined;
}) {
  const [view, setView] = useState<View>(knowledge ? { path: "INDEX.md", position: 1, folder: false } : top);
  const [trail, setTrail] = useState<View[]>([]);
  const [saved, setSaved] = useState("");
  const [data, setData] = useState<{
    view: View;
    rescan: number;
    dir?: DirectoryPage;
    file?: FilePage;
    error?: string;
    stale?: boolean;
  }>();
  const [line, setLine] = useState("1");
  const [rescan, setRescan] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const key = view.folder ? "entries" : "file";
    api(token, `/api/projects/${project.id}/${key}`, "POST", {
      root: project.root,
      path: view.path,
      ...(view.folder ? { offset: view.position } : { start: view.position, version: view.version }),
    })
      .then((r) => r.json())
      .then((result) => {
        if (current) setData(view.folder ? { view, rescan, dir: result } : { view, rescan, file: result });
      })
      .catch((e) => {
        if (current) {
          setData((previous) => ({
            ...(previous?.view === view && previous.dir ? { dir: previous.dir } : {}),
            view,
            rescan,
            error: message(e),
            stale: e instanceof SearchResultChanged,
          }));
        }
      });
    return () => {
      current = false;
    };
  }, [active, project.id, token, view, project.root, rescan]);
  const result = data?.view === view ? data : undefined;
  const nextOffset = result?.dir?.next;
  const enter = (path: string, folder: boolean, position = 1, end?: number) => {
    setSaved("");
    setView({ path, folder, position: folder ? 0 : position, ...(end !== undefined && { end }) });
    setLine(String(position));
  };
  const jump = (position: number) => {
    setView({
      path: view.path,
      folder: view.folder,
      position,
      ...(view.version && { version: view.version }),
    });
    setLine(String(position));
  };
  return (
    <section className="file-browser" aria-label={knowledge ? "지식 문서" : "작업 파일"}>
      <header>
        <strong>{view.path || "작업 폴더"}</strong>
        {knowledge && trail.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const previous = trail[trail.length - 1];
              if (!previous) return;
              setTrail(trail.slice(0, -1));
              setView(previous);
              setLine(String(previous.position));
            }}
          >
            이전 문서
          </button>
        )}
        {knowledge && (trail.length > 0 || view.position > 1) && (
          <button
            type="button"
            onClick={() => {
              setTrail([]);
              enter("INDEX.md", false);
            }}
          >
            처음 안내도
          </button>
        )}
        {result?.dir && !result.error && (
          <button type="button" disabled={result.rescan !== rescan} onClick={() => setRescan((n) => n + 1)}>
            {result.rescan === rescan ? "폴더 목록 새로고침" : "목록 읽는 중…"}
          </button>
        )}
        {!knowledge && view.path && (
          <button type="button" onClick={() => enter(view.path.split("/").slice(0, -1).join("/"), true)}>
            상위 폴더
          </button>
        )}
      </header>
      {!knowledge && (
        <>
          <SectionStateSource
            key={section.id}
            token={token}
            project={project}
            section={section}
            path={view.path}
            file={result?.file}
            refresh={refresh}
          />
          <WorkspaceSearch
            token={token}
            project={project}
            folder={view.folder ? view.path : view.path.split("/").slice(0, -1).join("/")}
            open={(hit) => {
              setSaved("");
              setView({
                path: hit.path,
                folder: false,
                position: hit.line,
                version: hit.version,
                excerpt: hit.excerpt,
              });
              setLine(String(hit.line));
            }}
          />
        </>
      )}
      {knowledge && <small>안내도의 링크를 따라가서 대화에 사용할 원본 범위를 고르세요.</small>}
      {!knowledge && project.writable && result && (result.dir || result.file) && (
        <FileWrite
          key={`${view.path}:${result.file?.version ?? "directory"}`}
          token={token}
          project={project}
          path={view.path}
          session={current?.id}
          version={result.file?.version ?? null}
          saved={(p) => {
            enter(p, false);
            setSaved(p);
          }}
        />
      )}
      {saved === view.path && saved && <output>저장했습니다 · {saved}</output>}
      {!result && <output>불러오는 중…</output>}
      {result?.error && (
        <>
          <p role="alert">{result.error}</p>
          {knowledge && view.path === "INDEX.md" && (
            <small>연결한 작업 폴더의 INDEX.md가 지식 안내도의 시작 문서입니다.</small>
          )}
          {result.stale && (
            <button type="button" onClick={() => enter(view.path, false)}>
              최신 파일 1줄부터 열기
            </button>
          )}
          <button type="button" onClick={() => setRescan((n) => n + 1)}>
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
          {view.excerpt && result.file.clipped && <p>검색 일치 부분 · {view.excerpt}</p>}
          <pre>{result.file.text}</pre>
          {((knowledge && /\.md$/i.test(view.path)) ||
            view.path.split("/").at(-1)?.toLowerCase() === "index.md") && (
            <IndexLinks
              path={view.path}
              text={result.file.text}
              open={(p, line, end) => {
                if (knowledge) setTrail((previous) => [...previous.slice(-31), view]);
                enter(p, false, line, end);
              }}
            />
          )}
          {current && result.file.total > 0 && (
            <AttachLines
              key={`${current.id}:${view.path}:${result.file.start}:${result.file.version}:${view.end ?? ""}`}
              token={token}
              project={project}
              path={view.path}
              page={result.file}
              rangeEnd={view.end}
              kind={knowledge ? "knowledge" : "file"}
              session={current}
              reopen={() => enter(view.path, false)}
            />
          )}
          {knowledge && !current && <small>대화를 열면 선택한 줄을 지식 발췌로 추가할 수 있습니다.</small>}
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
function IndexLinks({
  path,
  text,
  open,
}: {
  path: string;
  text: string;
  open: (p: string, line: number, end?: number) => void;
}) {
  const links = new Map<string, { label: string; path: string; line: number; end?: number }>();
  for (const match of text.matchAll(/(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
    const [target, anchor] = (match[2] ?? "").split("#");
    const line = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(anchor ?? "");
    const position = line ? Number(line[1]) : 1;
    const end = line?.[2] ? Number(line[2]) : undefined;
    if (
      !Number.isSafeInteger(position) ||
      (end !== undefined && (!Number.isSafeInteger(end) || end < position))
    )
      continue;
    if (!target || /[:\\]/.test(target) || target.startsWith("/")) continue;
    const parts = path.split("/").slice(0, -1);
    let valid = true;
    for (const p of target.split("/")) {
      if (p === "..") {
        if (!parts.length) {
          valid = false;
          break;
        }
        parts.pop();
      } else if (p && p !== ".") parts.push(p);
    }
    if (valid && parts.length) {
      const path = parts.join("/");
      links.set(`${path}#${position}-${end ?? ""}`, {
        label: match[1] ?? target,
        path,
        line: position,
        ...(end !== undefined && { end }),
      });
    }
  }
  return (
    links.size > 0 && (
      <section className="index-links" aria-label="안내도 링크">
        {[...links].map(([key, link]) => (
          <button type="button" key={key} onClick={() => open(link.path, link.line, link.end)}>
            {link.label} · {link.path}
            {link.end !== undefined ? ` · ${link.line}–${link.end}줄` : link.line > 1 && ` · ${link.line}줄`}
          </button>
        ))}
      </section>
    )
  );
}
function ProjectFolder({
  section,
  current,
  token,
  project,
  refresh,
}: {
  section: Section | undefined;
  token: string;
  project: Project;
  refresh: (id: string) => Promise<void>;
  current: Session | undefined;
}) {
  const [path, setPath] = useState(project.root ?? "");
  const [writable, setWritable] = useState(Boolean(project.writable));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function link(path: string | null) {
    setBusy(true);
    setError("");
    try {
      await api(token, `/api/projects/${project.id}/root`, "PUT", {
        path,
        previous: project.root,
        writable: path !== null && writable,
      });
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
            const trimmed = path.trim();
            const cleaned =
              trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
                ? trimmed.slice(1, -1)
                : trimmed;
            void link(cleaned);
          }}
        >
          <label>
            작업 폴더 절대 경로
            <input required value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
          <label className="match-case">
            <input type="checkbox" checked={writable} onChange={(e) => setWritable(e.target.checked)} />
            승인형 저장 허용
          </label>
          <button type="submit" disabled={busy || !path.trim()}>
            {writable ? "승인형 저장으로 연결" : "읽기 전용 연결"}
          </button>
          {project.root && (
            <button disabled={busy} type="button" onClick={() => void link(null)}>
              연결 해제
            </button>
          )}
        </form>
        {error && <p role="alert">{error}</p>}
      </details>
      {project.root && section && (
        <FileBrowser token={token} project={project} current={current} section={section} refresh={refresh} />
      )}
    </>
  );
}

export function ProjectWorkspace({
  token,
  sessions,
  current,
  close,
  openSession,
  onSectionChanged,
  streaming,
}: {
  token: string;
  sessions: Session[];
  current?: Session | undefined;
  close: () => void;
  openSession: (session: Session) => void;
  onSectionChanged: (session: Session) => void;
  streaming: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"files" | "knowledge" | "activity">("files");
  const [catalog, setCatalog] = useState<WorkspaceCatalog>();
  const [projectId, setProject] = useState(() => sessionStorage.getItem("ags-project") ?? ""),
    [sectionId, setSection] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const route = "/api/projects";
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const media = window.matchMedia("(min-width: 1000px)");
    const layout = () => {
      if (el.open) el.close();
      if (media.matches) el.show();
      else el.showModal();
    };
    layout();
    media.addEventListener("change", layout);
    return () => {
      media.removeEventListener("change", layout);
      el.close();
    };
  }, []);
  useEffect(() => {
    let alive = true;
    api(token, route)
      .then((r) => r.json())
      .then((data: WorkspaceCatalog) => {
        if (!alive) return;
        const selected = data.sections.find((s) => s.id === current?.sectionId);
        setCatalog(data);
        if (selected) {
          setProject(selected.projectId);
          setSection(selected.id);
        }
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
  async function changeCurrentSection(sectionId: string | null) {
    if (!current || busy) return;
    const path = `/api/sessions/${current.id}`;
    setBusy(true);
    setError("");
    try {
      const response = await api(token, `${path}/section`, "PUT", {
        sectionId, previousSectionId: current.sectionId ?? null, sectionRevision: current.sectionRevision,
      });
      onSectionChanged(await response.json());
    } catch (e) {
      setError(message(e));
      try {
        const data = await (await api(token, path)).json();
        onSectionChanged(data.session);
      } catch { /* Preserve the original error if the session cannot be refreshed. */ }
    } finally {
      setBusy(false);
    }
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
      id="project-workspace"
      ref={dialog}
      className="settings-center project-workspace"
      aria-labelledby="workspace-heading"
      onCancel={close}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !dialog.current?.matches(":modal")) {
          e.preventDefault();
          close();
        }
      }}
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
              {current && !current.sectionId && section && (
                <button type="button" disabled={busy || streaming} onClick={() => void changeCurrentSection(section.id)}>
                  현재 대화를 ‘{section.name}’ 섹션에 연결
                </button>
              )}
              {current?.sectionId && current.sectionId === section?.id && (
                <button type="button" disabled={busy || streaming} onClick={() => void changeCurrentSection(null)}>
                  현재 대화의 섹션 연결 해제
                </button>
              )}
              {sessions
                .filter((s) => s.sectionId === section?.id && !s.archived)
                .map((s) => (
                  <button type="button" key={s.id} onClick={() => openSession(s)}>
                    {s.title}
                  </button>
                ))}
            </div>
            <fieldset className="workspace-views" aria-label="작업공간 보기">
              <button type="button" aria-pressed={tab === "files"} onClick={() => setTab("files")}>
                파일
              </button>
              <button type="button" aria-pressed={tab === "knowledge"} onClick={() => setTab("knowledge")}>
                지식 안내도
              </button>
              <button type="button" aria-pressed={tab === "activity"} onClick={() => setTab("activity")}>
                활동 기록
              </button>
            </fieldset>
            <div hidden={tab !== "files"}>
              <ProjectFolder
                section={section}
                current={current}
                key={project.root ?? ""}
                token={token}
                project={project}
                refresh={refresh}
              />
            </div>
            <div hidden={tab !== "knowledge"}>
              {project.root && section ? (
                <FileBrowser
                  key={project.root}
                  token={token}
                  project={project}
                  section={section}
                  current={current}
                  refresh={refresh}
                  knowledge
                  active={tab === "knowledge"}
                />
              ) : (
                <small>파일 탭에서 프로젝트의 작업 폴더를 먼저 연결하세요.</small>
              )}
            </div>
            {tab === "activity" && <WorkspaceActivity token={token} project={project.id} />}
          </section>
        )}
      </div>
    </dialog>
  );
}
