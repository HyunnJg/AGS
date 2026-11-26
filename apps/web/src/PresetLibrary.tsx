import { useEffect, useState } from "react";
import {
  isPresetDraft,
  maxPresetName,
  maxPresetText,
  normalizePresetText,
  type CustomPreset,
  type CustomPresetSummary,
} from "../../../packages/contracts/src/sessions.ts";
import { api } from "./api.ts";

const presetsPath = "/api/settings/presets";

function usePresetRead<T>(token: string, path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [request, setRequest] = useState({ path });
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setError("");
    api(token, request.path, "GET", undefined, signal)
      .then((response) => response.json())
      .then((value: T) => {
        if (!signal.aborted) setData(value);
      })
      .catch((e: unknown) => {
        if (!signal.aborted) setError(e instanceof Error ? e.message : "프리셋을 읽지 못했습니다.");
      });
    return () => controller.abort();
  }, [token, request]);
  return { data, error, reload: () => setRequest({ path }) };
}

function PresetBody({ token, id }: { token: string; id: string }) {
  const { data, error, reload } = usePresetRead<CustomPreset>(token, `${presetsPath}/${id}`);
  if (error)
    return (
      <div role="alert">
        {error}{" "}
        <button type="button" onClick={reload}>
          본문 다시 읽기
        </button>
      </div>
    );
  return data ? <pre>{data.instructions}</pre> : <small>본문을 읽는 중…</small>;
}

function PresetRow({ token, preset, onChange }: {
  token: string;
  preset: CustomPresetSummary;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function toggleArchive() {
    setBusy(true);
    setError("");
    try {
      await api(token, `${presetsPath}/${preset.id}/archive`, "PUT", { archived: !preset.archived });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "보관 상태를 변경하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{preset.name}{preset.archived && " (보관됨)"}</summary>
      {open && <>
        <PresetBody token={token} id={preset.id} />
        <button type="button" disabled={busy} onClick={() => void toggleArchive()}>
          {preset.archived ? "선택 목록에 복원" : "프리셋 보관"}
        </button>
        {error && <div role="alert">{error}</div>}
      </>}
    </details>
  );
}

export function PresetLibrary({ token }: { token: string }) {
  const list = usePresetRead<CustomPresetSummary[]>(token, `${presetsPath}?includeArchived=1`);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function read(file: File) {
    setBusy(true);
    try {
      if (file.size > 4 * maxPresetText) throw new Error("8,000자 이내의 파일을 선택하세요.");
      const text = normalizePresetText(
        new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()),
      );
      if (!text.trim() || text.length > maxPresetText || text.includes("\0"))
        throw new Error("내용이 있는 8,000자 이내의 UTF-8 문서를 선택하세요.");
      setName(file.name.replace(/\.(md|markdown|txt)$/i, "").slice(0, maxPresetName));
      setInstructions(text);
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof TypeError
          ? "UTF-8 텍스트 파일을 선택하세요."
          : error instanceof Error
            ? error.message
            : "파일을 읽지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    try {
      const saved: CustomPreset = await (await api(token, presetsPath, "POST", { name, instructions })).json();
      list.reload();
      setMessage(saved.archived
        ? `‘${saved.name}’은 보관 중입니다. 아래 목록에서 복원할 수 있습니다.`
        : `‘${saved.name}’ 등록 완료 · 대화 상단의 프리셋에서 선택하세요.`);
      setName("");
      setInstructions("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "프리셋을 등록하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="source-fields">
          <label>
            Markdown 파일 가져오기
            <input
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void read(file);
              }}
            />
          </label>
          <label>
            프리셋 이름
            <input value={name} maxLength={maxPresetName} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            분야 지침
            <textarea
              value={instructions}
              maxLength={maxPresetText}
              rows={8}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <small>
            파일을 가져오거나 지침을 직접 입력하세요. 등록한 내용은 이 프리셋을 선택한 대화의 시스템 지침에
            들어갑니다.
          </small>
          <button type="submit" disabled={!isPresetDraft({ name, instructions })}>
            프리셋 등록
          </button>
        </fieldset>
        {message && <output>{message}</output>}
      </form>
      <section className="context-preview" aria-label="등록된 프리셋">
        <h4>등록된 프리셋</h4>
        {list.error && (
          <div role="alert">
            {list.error}{" "}
            <button type="button" onClick={list.reload}>
              목록 다시 읽기
            </button>
          </div>
        )}
        {!list.data && !list.error && <small>목록을 읽는 중…</small>}
        {list.data?.length === 0 && <small>등록된 프리셋이 없습니다.</small>}
        {list.data?.map((preset) => (
          <PresetRow key={preset.id} token={token} preset={preset} onChange={list.reload} />
        ))}
      </section>
    </>
  );
}
