import { useEffect, useState } from "react";
import {
  maxRules,
  maxText,
  ruleError,
  type DisplaySettings,
  type DisplayRule,
} from "../../../packages/contracts/src/display.ts";
import { api, SettingsConflict } from "./api.ts";
import { useDisplayText } from "./useDisplayText.ts";

function CopyReply({ text }: { text: string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!message) return;
    const timeout = setTimeout(() => setMessage(""), 4000);
    return () => clearTimeout(timeout);
  }, [message]);
  async function copy() {
    setMessage("");
    setPending(true);
    try {
      await navigator.clipboard.writeText(text);
      setMessage("복사했습니다.");
    } catch {
      setMessage("클립보드에 복사할 수 없습니다. 답변을 선택해 직접 복사하세요.");
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <button className="raw-reply" type="button" title="현재 표시된 답변 복사" disabled={pending} onClick={() => void copy()}>
        답변 복사
      </button>
      <output>{message}</output>
    </>
  );
}

export function ReplyText({
  text,
  rules,
  finished,
}: {
  text: string;
  rules: DisplayRule[];
  finished: boolean;
}) {
  const [original, showOriginal] = useState(false);
  const result = useDisplayText(text, rules, finished);
  const visibleText = original ? text : result.text;
  return (
    <>
      <div className="reply">{visibleText}</div>
      {result.error && <small>{result.error} 원문을 표시합니다.</small>}
      {text !== result.text && (
        <button
          className="raw-reply"
          type="button"
          aria-pressed={original}
          onClick={() => showOriginal(!original)}
        >
          {original ? "치환 결과 보기" : "원문 보기"}
        </button>
      )}
      {finished && visibleText && <CopyReply key={original ? "original" : "display"} text={visibleText} />}
    </>
  );
}

const path = "/api/settings/display-rules";
export function DisplayRules({ token, onSaved }: { token: string; onSaved: (rules: DisplayRule[]) => void }) {
  const [saved, setSaved] = useState<DisplaySettings>();
  const [rules, setRules] = useState<DisplayRule[]>([]);
  const [sample, setSample] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    let alive = true;
    api(token, path)
      .then((r) => r.json())
      .then((data) => {
        if (alive) {
          setSaved(data);
          setRules(data.rules);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [token]);
  const invalid = ruleError(rules);
  const preview = useDisplayText(sample, rules, !invalid);
  const changed = JSON.stringify(rules) !== JSON.stringify(saved?.rules);
  function edit(id: string, change: Partial<DisplayRule>) {
    setRules((rows) => rows.map((row) => (row.id === id ? { ...row, ...change } : row)));
  }
  function move(from: number, to: number) {
    const next = rules.slice();
    next.splice(to, 0, ...next.splice(from, 1));
    setRules(next);
  }
  async function persist(reload: boolean) {
    if (!saved) return;
    setBusy(true);
    setError("");
    try {
      const response = reload
        ? await api(token, path)
        : await api(token, path, "PUT", { revision: saved.revision, rules });
      const data: DisplaySettings = await response.json();
      setSaved(data);
      setRules(data.rules);
      onSaved(data.rules);
      setConflict(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "규칙을 저장하지 못했습니다.");
      setConflict(e instanceof SettingsConflict);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="display-rules"
      onSubmit={(e) => {
        e.preventDefault();
        void persist(false);
      }}
    >
      <small>
        응답이 끝나면 위에서 아래 순서로 표시를 바꿉니다. 저장 기록과 다음 요청에는 원문이 쓰입니다.
      </small>
      <fieldset disabled={busy || !saved} className="rule-controls">
        {rules.map((r, i) => (
          <fieldset className="rule-card" key={r.id}>
            <legend>{r.name || "새 규칙"}</legend>
            <div className="rule-tools">
              <label>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => edit(r.id, { enabled: e.target.checked })}
                />
                사용
              </label>
              <button
                type="button"
                aria-label={`${r.name} 위로`}
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`${r.name} 아래로`}
                disabled={i === rules.length - 1}
                onClick={() => move(i, i + 1)}
              >
                ↓
              </button>
              <button type="button" onClick={() => setRules((rows) => rows.filter((row) => row.id !== r.id))}>
                삭제
              </button>
            </div>
            <label>
              이름
              <input maxLength={64} value={r.name} onChange={(e) => edit(r.id, { name: e.target.value })} />
            </label>
            <label>
              패턴
              <input
                spellCheck={false}
                maxLength={256}
                value={r.pattern}
                onChange={(e) => edit(r.id, { pattern: e.target.value })}
              />
            </label>
            <label>
              플래그
              <input
                spellCheck={false}
                maxLength={5}
                value={r.flags}
                onChange={(e) => edit(r.id, { flags: e.target.value })}
              />
            </label>
            <label>
              치환문
              <input
                maxLength={512}
                value={r.replacement}
                onChange={(e) => edit(r.id, { replacement: e.target.value })}
              />
            </label>
          </fieldset>
        ))}
        <button
          type="button"
          disabled={rules.length >= maxRules}
          onClick={() =>
            setRules((rows) => [
              ...rows,
              {
                id: crypto.randomUUID(),
                name: `규칙 ${rows.length + 1}`,
                pattern: "",
                flags: "g",
                replacement: "",
                enabled: true,
              },
            ])
          }
        >
          규칙 추가
        </button>
      </fieldset>
      {invalid && <small role="alert">{invalid}</small>}
      <label>
        테스트 문장
        <textarea rows={2} maxLength={maxText} value={sample} onChange={(e) => setSample(e.target.value)} />
      </label>
      <div className="context-preview">
        <strong>표시 미리보기</strong>
        <output aria-label="치환 결과">{preview.text}</output>
        {preview.error && <small role="alert">{preview.error} 원문을 표시합니다.</small>}
      </div>
      {error && <p role="alert">{error}</p>}
      {conflict && (
        <button type="button" disabled={busy} onClick={() => void persist(true)}>
          초안 대신 최신 규칙 불러오기
        </button>
      )}
      <footer>
        <button
          type="submit"
          className="primary"
          disabled={!saved || busy || !!invalid || conflict || !changed}
        >
          규칙 저장
        </button>
      </footer>
    </form>
  );
}
