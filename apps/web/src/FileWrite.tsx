import { useEffect, useRef, useState } from "react";
import type { Project, WritePreview } from "../../../packages/contracts/src/workspace.ts";
import { api, WriteConflict } from "./api.ts";

export function FileWrite({
  token,
  project,
  path,
  version,
  saved,
  initialFile,
  session,
}: {
  initialFile?: { name: string; text: string };
  session: string | undefined;
  token: string;
  project: Project;
  path: string;
  version: string | null;
  saved: (path: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [text, setText] = useState("");
  const [preview, setPreview] = useState<WritePreview>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [baseVersion, setBaseVersion] = useState(version);
  const [conflicted, setConflicted] = useState(false);
  const [savingCopy, setSavingCopy] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const creating = version === null || savingCopy;
  const parts = path.split("/");
  const originalName = parts.at(-1) ?? "";
  const directory = savingCopy ? parts.slice(0, -1).join("/") : path;
  const target = creating ? [directory, name].filter(Boolean).join("/") : path;
  const invalidCopyName = savingCopy && (/[/\\]/.test(name) || name.toLowerCase() === originalName.toLowerCase());
  const invalidName = creating && (!name.trim() || invalidCopyName);
  const route = `/api/projects/${project.id}`;
  function beginCopy() {
    const dot = originalName.lastIndexOf(".");
    const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
    const ext = dot > 0 ? originalName.slice(dot) : "";
    setName(`${stem}-초안${ext}`);
    setSavingCopy(true);
    setPreview(undefined);
    setConflicted(false);
    setError("");
  }
  function fail(e: unknown) {
    if (active.current) {
      setError(e instanceof Error ? e.message : "파일을 저장하지 못했습니다.");
      if (e instanceof WriteConflict) setConflicted(true);
    }
  }
  async function begin() {
    setError("");
    setBusy(true);
    try {
      if (creating && initialFile) {
        setName(initialFile.name);
        setText(initialFile.text);
      }
      if (!creating) {
        const requestedVersion = conflicted
          ? (await (await api(token, `${route}/file`, "POST", { path, root: project.root })).json()).version
          : version;
        const data = await (
          await api(token, `${route}/edit`, "POST", {
            path,
            root: project.root,
            version: requestedVersion,
          })
        ).json();
        if (active.current) {
          setText(data.text.replace(/\r\n|\r/g, "\n"));
          setBaseVersion(requestedVersion);
          setConflicted(false);
        }
      }
      if (active.current) setOpen(true);
    } catch (e) {
      fail(e);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function loadReply() {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const data = await (await api(token, `/api/sessions/${session}`)).json();
      const last = data.turns.findLast(
        (turn: { status: string; reply: string }) => turn.status === "completed" && turn.reply.trim(),
      );
      if (active.current) {
        if (last) setText(last.reply);
        else setError("현재 대화에 완료된 답변이 없습니다.");
      }
    } catch (e) {
      fail(e);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function compare(refresh = false) {
    setError("");
    setBusy(true);
    try {
      const latest = refresh
        ? (
            await (
              await api(token, `${route}/file`, "POST", {
                path: target,
                root: project.root,
              })
            ).json()
          ).version
        : creating ? null : baseVersion;
      const proposal = await (
        await api(token, `${route}/propose`, "POST", {
          path: target,
          root: project.root,
          text,
          version: latest,
        })
      ).json();
      if (active.current) {
        setPreview(proposal);
        setBaseVersion(latest);
        setConflicted(false);
      }
    } catch (e) {
      fail(e);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function approve() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      await api(token, `${route}/approve`, "POST", {
        id: preview.id,
        approved: true,
        path: preview.path,
        root: project.root,
      });
      if (active.current) {
        setOpen(false);
        setPreview(undefined);
        setSavingCopy(false);
        saved(preview.path);
      }
    } catch (e) {
      fail(e);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className="file-write" aria-label="파일 변경">
      {!open && (
        <button type="button" disabled={busy} onClick={() => void begin()}>
          {initialFile ? "검토 결과 파일로 저장" : creating ? "새 파일" : "파일 수정"}
        </button>
      )}
      {open && (
        <fieldset disabled={busy}>
          {preview ? (
            <>
              <legend>{preview.path} · 변경 미리보기</legend>
              <small>{preview.action === "create" ? "새 파일" : `변경 시작 · ${preview.first}줄`}</small>
              {!!preview.removed.length && (
                <pre className="removed">{preview.removed.map((l) => `− ${l}`).join("\n")}</pre>
              )}
              {!!preview.added.length && (
                <pre className="added">{preview.added.map((l) => `+ ${l}`).join("\n")}</pre>
              )}
              <button
                type="button"
                onClick={() => {
                  setPreview(undefined);
                  setError("");
                }}
              >
                수정안 편집
              </button>
              <button className="primary" type="button" disabled={conflicted} onClick={() => void approve()}>
                승인하고 저장
              </button>
            </>
          ) : (
            <>
              {creating && (
                <label>
                  새 파일 이름
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                  {savingCopy && <small>같은 폴더에 저장할 새 파일 이름을 입력하세요.</small>}
                </label>
              )}
              {session && (
                <button type="button" onClick={() => void loadReply()}>
                  현재 대화의 마지막 답변 가져오기
                </button>
              )}
              <label>
                수정안
                <textarea
                  aria-label="수정안"
                  rows={8}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <button type="button" disabled={invalidName} onClick={() => void compare()}>
                변경 비교
              </button>
            </>
          )}
          {!creating && (
            <button type="button" onClick={beginCopy}>
              초안을 다른 이름으로 저장
            </button>
          )}
          {conflicted && !creating && (
            <button type="button" onClick={() => void compare(true)}>
              최신 원본과 다시 비교
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setConflicted(false);
              setSavingCopy(false);
              setBaseVersion(version);
              setOpen(false);
              setPreview(undefined);
              setText("");
              setName("");
              setError("");
            }}
          >
            취소
          </button>
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
