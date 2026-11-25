import { useEffect, useState } from "react";
import {
  blockNames,
  defaultOrder,
  systemText,
  maxPromptLength,
  maxSourceLength,
  type PromptSettings,
  type SessionSources,
} from "../../../packages/contracts/src/context.ts";
import type { Session } from "../../../packages/contracts/src/sessions.ts";
import { api, SettingsConflict } from "./api.ts";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "저장할 수 없습니다.");

export function SourceEditor({ token, id, onSaved }: { token: string; id: string; onSaved: () => void }) {
  const path = `/api/sessions/${id}/sources`;
  const [saved, setSaved] = useState<SessionSources>();
  const [memory, setMemory] = useState("");
  const [retrieval, setRetrieval] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [compare, setCompare] = useState(false);
  useEffect(() => {
    let alive = true;
    api(token, path)
      .then((r) => r.json())
      .then((data) => {
        if (alive) {
          setSaved(data);
          setMemory(data.memory);
          setRetrieval(data.retrieval);
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [token, path]);
  async function submit(reload: boolean) {
    if (!saved) return;
    setBusy(true);
    setError("");
    try {
      const row = await (reload
        ? await api(token, path)
        : await api(token, path, "PUT", { memory, retrieval, revision: saved.revision })
      ).json();
      setSaved(row);
      setCompare(reload);
      setConflict(false);
      if (!reload) onSaved();
    } catch (e) {
      setError(errorText(e));
      setConflict(e instanceof SettingsConflict);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>이 대화의 참고 자료</summary>
      <div className="source-fields">
        <small>직접 입력한 내용은 이 대화의 다음 요청에 포함됩니다. 비워 두면 생략합니다.</small>
        <label>
          장기기억 메모
          <textarea
            disabled={!saved || busy}
            rows={3}
            maxLength={maxSourceLength}
            value={memory}
            onChange={(e) => setMemory(e.target.value)}
          />
        </label>
        <label>
          검색·임베딩 자료 (직접 입력)
          <textarea
            disabled={!saved || busy}
            rows={3}
            maxLength={maxSourceLength}
            value={retrieval}
            onChange={(e) => setRetrieval(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        {conflict && (
          <button type="button" disabled={busy} onClick={() => void submit(true)}>
            최신 내용 불러오기
          </button>
        )}
        {compare && saved && (
          <div className="context-preview">
            <strong>현재 저장된 참고 자료</strong>
            <pre>{saved.memory || "(빈 메모)"}</pre>
            <pre>{saved.retrieval || "(빈 자료)"}</pre>
          </div>
        )}
        <button
          type="button"
          disabled={!saved || busy || conflict || (saved.memory === memory && saved.retrieval === retrieval)}
          onClick={() => void submit(false)}
        >
          참고 자료 저장
        </button>
      </div>
    </details>
  );
}

export function SharedPrompt({ token, session }: { token: string; session?: Session }) {
  const path = "/api/settings/prompt";
  const [stored, setStored] = useState<PromptSettings>();
  const [prompt, setPrompt] = useState("");
  const [order, setOrder] = useState([...defaultOrder]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [compare, setCompare] = useState(false);
  useEffect(() => {
    let alive = true;
    api(token, path)
      .then((r) => r.json())
      .then((data) => {
        if (alive) {
          setStored(data);
          setPrompt(data.prompt);
          setOrder(data.order);
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [token]);
  function move(from: number, to: number) {
    const next = order.slice();
    const item = next.splice(from, 1)[0];
    if (item) {
      next.splice(to, 0, item);
      setOrder(next);
    }
  }
  async function submit(reload: boolean) {
    if (!stored) return;
    setBusy(true);
    setError("");
    try {
      const response = reload
        ? await api(token, path)
        : await api(token, path, "PUT", {
            prompt,
            order,
            previous: stored.prompt,
            previousOrder: stored.order,
          });
      setStored(await response.json());
      setCompare(reload);
      setConflict(false);
    } catch (e) {
      setError(errorText(e));
      setConflict(e instanceof SettingsConflict);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
    >
      <label>
        모든 대화의 공용 지침
        <textarea
          rows={4}
          maxLength={maxPromptLength}
          disabled={!stored || busy}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <details className="context-preview">
        <summary>고정 지침 미리보기</summary>
        <pre>{systemText(prompt, session?.preset ?? "general")}</pre>
      </details>
      <strong>컨텍스트 주입 순서</strong>
      <small>
        고정 지침 다음에 아래 순서로 전송합니다. 자주 바뀌는 블록을 뒤에 두면 앞부분을 재사용하기 좋습니다.
      </small>
      <ol className="block-order">
        {order.map((block, i) => (
          <li key={block}>
            <span>{blockNames[block]}</span>
            <button
              type="button"
              aria-label={`${blockNames[block]} 위로`}
              disabled={!stored || busy || i === 0}
              onClick={() => move(i, i - 1)}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`${blockNames[block]} 아래로`}
              disabled={!stored || busy || i === order.length - 1}
              onClick={() => move(i, i + 1)}
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
      {error && <p role="alert">{error}</p>}
      {conflict && (
        <button type="button" onClick={() => void submit(true)} disabled={busy}>
          최신 내용 불러오기
        </button>
      )}
      {compare && stored && (
        <div className="context-preview">
          <strong>현재 저장된 설정</strong>
          <pre>{stored.prompt || "(빈 지침)"}</pre>
          <small>{stored.order.map((b) => blockNames[b]).join(" → ")}</small>
        </div>
      )}
      <footer>
        <button
          type="submit"
          className="primary"
          disabled={
            busy || !stored || conflict || (prompt === stored.prompt && order.join() === stored.order.join())
          }
        >
          저장
        </button>
      </footer>
    </form>
  );
}
