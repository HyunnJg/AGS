import { useEffect, useState, type FormEvent } from "react";
import {
  maxReferenceChars,
  type FilePage,
  type FileReference,
  type Project,
} from "../../../packages/contracts/src/workspace.ts";
import type { Session } from "../../../packages/contracts/src/sessions.ts";
import { api, SearchResultChanged } from "./api.ts";

const changed = "ags-file-references";

export function AttachLines({
  token,
  session,
  project,
  path,
  page,
  reopen,
}: {
  token: string;
  session: Session;
  project: Project;
  path: string;
  page: FilePage;
  reopen: () => void;
}) {
  const [first, setFirst] = useState(String(page.start)),
    [last, setLast] = useState(String(page.end));
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [stale, setStale] = useState(false);
  const start = Number(first),
    end = Number(last);
  const valid =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= page.start &&
    start <= end &&
    end <= page.end;
  const selected = valid
    ? page.text
        .split("\n")
        .slice(start - page.start, end - page.start + 1)
        .join("\n")
    : "";
  async function attach(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(token, `/api/projects/${project.id}/attach`, "POST", {
        root: project.root,
        path,
        start,
        end,
        version: page.version,
        session: session.id,
      });
      window.dispatchEvent(new CustomEvent(changed, { detail: session.id }));
      setNotice(`${start}–${end}줄을 첨부했습니다.`);
    } catch (e) {
      setError(
        e instanceof SearchResultChanged
          ? "파일을 열어 본 뒤 내용이 바뀌었습니다. 최신 원본에서 첨부할 줄을 다시 선택하세요."
          : e instanceof Error
            ? e.message
            : "첨부하지 못했습니다.",
      );
      setStale(e instanceof SearchResultChanged);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="attach-lines">
      <form onSubmit={attach}>
        <label>
          첨부 시작 줄
          <input
            required
            disabled={busy}
            type="number"
            min={page.start}
            max={page.end}
            value={first}
            onChange={(e) => {
              setFirst(e.target.value);
              setNotice("");
            }}
          />
        </label>
        <label>
          첨부 끝 줄
          <input
            required
            disabled={busy}
            type="number"
            min={start || page.start}
            max={page.end}
            value={last}
            onChange={(e) => {
              setLast(e.target.value);
              setNotice("");
            }}
          />
        </label>
        <button
          type="submit"
          disabled={busy || stale || !selected.trim() || selected.length > maxReferenceChars}
        >
          현재 대화에 첨부
        </button>
      </form>
      <small>‘{session.title}’에서 뺄 때까지 전송할 참고 자료로 사용합니다.</small>
      {selected.length > maxReferenceChars && <p>첨부 범위를 6,000자 이내로 줄여 주세요.</p>}
      {notice && <output>{notice}</output>}
      {error && <p role="alert">{error}</p>}
      {stale && (
        <button type="button" onClick={reopen}>
          최신 파일 다시 열기
        </button>
      )}
    </div>
  );
}

export function AttachedReferences({ token, session }: { token: string; session: string }) {
  const [refs, setRefs] = useState<FileReference[]>([]),
    [error, setError] = useState("");
  const route = `/api/sessions/${session}/references`;
  useEffect(() => {
    let pending: AbortController | undefined;
    async function load() {
      pending?.abort();
      const c = new AbortController();
      pending = c;
      try {
        const rows = await (await api(token, route, "GET", undefined, c.signal)).json();
        if (!c.signal.aborted) {
          setRefs(rows);
          setError("");
        }
      } catch (e) {
        if (!c.signal.aborted) setError(e instanceof Error ? e.message : "첨부 목록을 읽지 못했습니다.");
      }
    }
    const update = (e: Event) => {
      if ((e as CustomEvent).detail === session) void load();
    };
    void load();
    window.addEventListener(changed, update);
    window.addEventListener("focus", load);
    return () => {
      pending?.abort();
      window.removeEventListener(changed, update);
      window.removeEventListener("focus", load);
    };
  }, [route, session, token]);
  async function remove(id: string) {
    try {
      await api(token, `${route}/${id}`, "DELETE");
      window.dispatchEvent(new CustomEvent(changed, { detail: session }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "첨부를 빼지 못했습니다.");
    }
  }
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {refs.length > 0 && (
        <details className="attached-references">
          <summary>첨부 자료 {refs.length}개</summary>
          {refs.map((r) => (
            <div key={r.id}>
              <strong>
                {r.project} / {r.path} · {r.start}–{r.end}줄
              </strong>
              <button type="button" onClick={() => void remove(r.id)}>
                첨부 빼기
              </button>
              <pre>{r.text}</pre>
            </div>
          ))}
        </details>
      )}
    </>
  );
}
