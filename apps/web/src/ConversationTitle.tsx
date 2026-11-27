import { useEffect, useRef, useState, type FormEvent } from "react";
import { maxSessionTitle, validSessionTitle } from "../../../packages/contracts/src/sessions.ts";
import { api, TitleConflict } from "./api.ts";

export function ConversationTitle({ token, id, title, onTitle }: {
  token: string;
  id: string;
  title: string;
  onTitle: (title: string) => void;
}) {
  const [previous, setPrevious] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const editing = previous !== null;
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  function close() {
    setPrevious(null);
    requestAnimationFrame(() => button.current?.focus());
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (previous === null || saving || !validSessionTitle(draft)) return;
    setSaving(true);
    setError("");
    try {
      const res = await api(token, `/api/sessions/${id}/title`, "PUT", { title: draft, previous });
      onTitle((await res.json()).title);
      close();
    } catch (e) {
      if (e instanceof TitleConflict) {
        onTitle(e.currentTitle);
        setPrevious(e.currentTitle);
      }
      setError(e instanceof Error ? e.message : "대화 이름을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  if (editing) return (
    <form className="rename-conversation" onSubmit={save}>
      <input ref={input} aria-label="대화 이름" value={draft} maxLength={maxSessionTitle} disabled={saving}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") close();
        }} />
      <button type="submit" disabled={saving || !validSessionTitle(draft)}>저장</button>
      <button type="button" disabled={saving} onClick={close}>취소</button>
      {error && <small role="alert">{error}</small>}
    </form>
  );
  return (
    <div className="session-heading">
      <h2 title={title}>{title}</h2>
      <button ref={button} type="button" aria-label="대화 이름 변경" onClick={() => {
        setPrevious(title);
        setDraft(title);
        setError("");
      }}>이름 변경</button>
    </div>
  );
}
