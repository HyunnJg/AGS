import { SourceEditor } from "./PromptLayout.tsx";
import { useState, useEffect } from "react";
import {
  staleStateMessage,
  memoryUseLabel,
  defaultLimits,
  isLimits,
  maxBudget,
  maxTurns,
  blockNames,
  type ContextLimits,
  type ContextPreview,
} from "../../../packages/contracts/src/context.ts";
import type { Session } from "../../../packages/contracts/src/sessions.ts";
import { api } from "./api.ts";

function problem(err: unknown) {
  return err instanceof Error ? err.message : "설정을 읽거나 저장하지 못했습니다.";
}

export function ContextSettings({
  token,
  session,
  draft,
}: {
  token: string;
  session: Session;
  draft: string;
}) {
  const path = `/api/sessions/${session.id}/context`;
  const [limits, setLimits] = useState<ContextLimits>(defaultLimits);
  const [saved, setSaved] = useState<ContextLimits>();
  const [preview, setPreview] = useState<ContextPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api(token, path)
      .then((r) => r.json())
      .then((data) => {
        if (alive) {
          setSaved(data);
          setLimits(data);
        }
      })
      .catch((e) => {
        if (alive) setError(problem(e));
      });
    return () => {
      alive = false;
    };
  }, [token, path]);
  async function run(action: "preview" | "save") {
    setBusy(true);
    setError("");
    try {
      if (action === "preview")
        setPreview(
          await (await api(token, `${path}-preview`, "POST", { message: draft.trim(), limits })).json(),
        );
      else setSaved(await (await api(token, path, "PUT", limits)).json());
    } catch (e) {
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  }
  const valid = !!saved && isLimits(limits);
  const changed =
    saved &&
    (saved.turns !== limits.turns ||
      saved.inputBudget !== limits.inputBudget ||
      saved.outputBudget !== limits.outputBudget);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run("save");
      }}
    >
      <small>적용할 대화 · {session.title}</small>
      <fieldset className="limit-fields" disabled={!saved || busy}>
        {(
          [
            ["turns", "최근 완료 대화 (턴)"],
            ["inputBudget", "입력 예산 (추정 토큰)"],
            ["outputBudget", "최대 출력 토큰"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min={key === "turns" ? 0 : 1}
              max={key === "turns" ? maxTurns : maxBudget}
              step={1}
              required={key === "turns"}
              value={Number.isNaN(limits[key]) ? "" : (limits[key] ?? "")}
              placeholder={key === "inputBudget" ? "제한 없음" : "공급자 기본값"}
              onChange={(e) => {
                const val = e.target.valueAsNumber;
                setLimits({ ...limits, [key]: Number.isNaN(val) && key !== "turns" ? null : val });
                setPreview(undefined);
              }}
            />
          </label>
        ))}
      </fieldset>
      <small>
        한글 한 글자는 보통 3바이트로 계산합니다. 입력은 UTF-8 바이트 수와 메시지 여유분으로 추정합니다.
        예산을 넘으면 오래된 턴부터 제외합니다.
      </small>
      <SourceEditor token={token} id={session.id} onSaved={() => setPreview(undefined)} />
      <footer>
        <button type="button" disabled={!valid || busy} onClick={() => void run("preview")}>
          전송 미리보기
        </button>
        <button type="submit" className="primary" disabled={!valid || busy || !changed}>
          저장
        </button>
      </footer>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <div className="context-preview">
          <strong>
            포함된 대화 {preview.includedTurns}턴 · 입력 약 {preview.estimatedInput.toLocaleString()}토큰
          </strong>
          {preview.modelWindow !== null && (
            <small>
              모델 컨텍스트 {preview.modelWindow.toLocaleString()}토큰 ·{" "}
              {preview.outputBudget === null
                ? "출력은 공급자 기본값"
                : `출력 예약 ${preview.outputBudget}토큰`}
            </small>
          )}
          {session.sectionId && preview.memoryUse && <small>{memoryUseLabel(preview.memoryUse)}</small>}
          {preview.stateStale && <output>{staleStateMessage}</output>}
          {!preview.fits && <p role="alert">지침과 현재 메시지가 남은 입력 예산을 넘습니다.</p>}
          {session.provider === "mock" && <small>로컬 mock은 외부로 전송하지 않습니다.</small>}
          {!!preview.excluded.length && (
            <small>
              예산으로 일부 또는 전체 제외 · {preview.excluded.map((b) => blockNames[b]).join(", ")}
            </small>
          )}
          {preview.messages.at(-1)?.role === "assistant" && (
            <small>
              마지막 메시지는 이전 모델 응답입니다. 사용자 메시지로 끝내려면 ‘현재 입력’을 마지막에
              배치하세요.
            </small>
          )}
          {preview.messages.some((m, i) => m.role === "user" && preview.messages[i - 1]?.role === "user") && (
            <small>
              사용자 역할 메시지가 연속됩니다. 역할 교대를 요구하는 공급자에서는 이 순서를 확인하세요.
            </small>
          )}
          {preview.messages.map((m, i) => (
            <details key={`${m.role}-${i}`}>
              <summary>
                {preview.blocks[i] === "system"
                  ? "시스템 · 공용 지침 · 프리셋"
                  : preview.blocks[i] === "history"
                    ? m.role === "user"
                      ? "이전 요청"
                      : "이전 응답"
                    : blockNames[preview.blocks[i] as keyof typeof blockNames]}
              </summary>
              <pre>{m.content || "(비어 있음)"}</pre>
            </details>
          ))}
        </div>
      )}
    </form>
  );
}
