import { useEffect, useRef, useState, type FormEvent } from "react";
import { maxTurnSearchQuery, type TurnSearchHit, type TurnSearchResponse } from "../../../packages/contracts/src/sessions.ts";
import { api } from "./api.ts";

export function ConversationSearch({ token, openHit }: {
  token: string;
  openHit: (hit: TurnSearchHit, close: () => void, signal: AbortSignal) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<TurnSearchResponse>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);

  function close() {
    request.current?.abort();
    dialog.current?.close();
    setOpen(false);
    setBusy(false);
  }

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      await action(controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "대화 본문을 읽지 못했습니다.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function search(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setData(undefined);
    void run(async signal => {
      const response = await api(token, "/api/sessions/search", "POST", { query: query.trim() }, signal);
      const result: TurnSearchResponse = await response.json();
      if (!signal.aborted) setData(result);
    });
  }

  return (
    <>
      <button type="button" className="body-search-launcher" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        대화 본문 검색
      </button>
      {open && (
        <dialog ref={dialog} aria-labelledby="body-search-title" className="body-search-dialog"
          onCancel={e => { e.preventDefault(); close(); }}>
          <h2 id="body-search-title">대화 본문 검색</h2>
          <form onSubmit={search}>
            <input type="search" aria-label="본문 검색어" placeholder="저장된 질문·답변 검색" value={query}
              maxLength={maxTurnSearchQuery} onChange={e => {
                request.current?.abort();
                setBusy(false);
                setData(undefined);
                setError("");
                setQuery(e.target.value);
              }} />
            <button type="submit" disabled={busy || !query.trim()}>검색</button>
          </form>
          {busy && <output>읽는 중…</output>}
          {error && <p role="alert">{error}</p>}
          {data && (
            <>
              <output>{data.truncated ? `검색 결과 중 ${data.results.length}건 표시` :
                data.results.length ? `검색 결과 ${data.results.length}건` : "일치하는 본문이 없습니다."}</output>
              <ul>
                {data.results.map(hit => (
                  <li key={`${hit.turnId}:${hit.field}`}>
                    <button type="button" disabled={busy} onClick={() => void run(signal => openHit(hit, close, signal))}>
                      <strong>{hit.title} · {hit.turnNumber}턴 · {hit.field === "message" ? "질문" : "답변"}</strong>
                      <span>{hit.snippet}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" onClick={close}>닫기</button>
        </dialog>
      )}
    </>
  );
}
