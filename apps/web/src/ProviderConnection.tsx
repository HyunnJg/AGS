import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  isModelSelection,
  type ConnectionId,
  type ConnectionView,
  type ProviderOption,
} from "../../../packages/contracts/src/providers.ts";
import { api } from "./api.ts";

export function ProviderConnection({
  provider,
  token,
  enabled,
  onSave,
  onBusy,
  selectedModel,
  children,
  locked,
}: {
  provider: ConnectionId;
  token: string;
  enabled: boolean;
  selectedModel: string;
  children: ReactNode;
  locked: boolean;
  onSave: (options: ProviderOption[], model: string, previous: string, connectionChanged: boolean) => void;
  onBusy: (value: boolean) => void;
}) {
  const path = `/api/settings/connections/${provider}`;
  const [expanded, setExpanded] = useState(!enabled);
  const [view, setView] = useState<ConnectionView>();
  const [url, setUrl] = useState("");
  const [model, setModel] = useState("");
  const keyInput = useRef<HTMLInputElement>(null);
  const [remove, setRemove] = useState(false);
  const [message, setMessage] = useState("");
  const [attempt, reload] = useState(0);
  useEffect(() => {
    let current = true;
    if (attempt) setMessage("연결 설정을 다시 읽는 중…");
    api(token, path)
      .then((r) => r.json())
      .then((data: ConnectionView) => {
        if (!current) return;
        setView(data);
        setUrl(data.baseUrl);
        setModel(data.defaultModel);
        setRemove(false);
        setMessage("");
        if (keyInput.current) keyInput.current.value = "";
      })
      .catch(() => {
        if (current) setMessage("연결 설정을 읽지 못했습니다.");
      });
    return () => {
      current = false;
    };
  }, [token, path, attempt]);
  async function save(defaultOnly?: string) {
    if (!view || locked) return;
    const connectionChanged = defaultOnly === undefined;
    onBusy(true);
    setMessage("");
    try {
      const entry = connectionChanged ? keyInput.current?.value.trim() : undefined;
      const data = await (
        await api(token, path, "PUT", {
          revision: view.revision,
          baseUrl: connectionChanged ? url.trim() : view.baseUrl,
          defaultModel: defaultOnly ?? (enabled ? view.defaultModel : model.trim()),
          ...(connectionChanged && remove ? { key: null } : entry ? { key: entry } : {}),
        })
      ).json();
      setView(data.view);
      setModel(data.view.defaultModel);
      if (connectionChanged) {
        if (keyInput.current) keyInput.current.value = "";
        setRemove(false);
        setUrl(data.view.baseUrl);
        setMessage("연결 설정을 저장했습니다.");
      } else {
        setMessage(defaultOnly ? "기본 모델을 저장했습니다." : "기본 모델을 해제했습니다.");
      }
      onSave(data.options, data.view.defaultModel, view.defaultModel, connectionChanged);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "연결 설정을 저장하지 못했습니다.");
    } finally {
      onBusy(false);
    }
  }
  return (
    <>
      <details
        className="provider-connection"
        open={expanded}
        onToggle={(e) => setExpanded(e.currentTarget.open)}
      >
        <summary>연결 설정</summary>
        {view && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            autoComplete="off"
          >
            <fieldset disabled={locked}>
              {provider === "custom" && (
                <label>
                  API 기본 주소
                  <input
                    type="url"
                    maxLength={2048}
                    placeholder="http://127.0.0.1:8080/v1"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </label>
              )}
              <label>
                API 키
                <input
                  type="password"
                  ref={keyInput}
                  disabled={remove}
                  autoComplete="new-password"
                  maxLength={4096}
                  placeholder={
                    view.hasKey
                      ? "등록됨 · 교체할 때만 입력"
                      : provider === "custom"
                        ? "키 없는 로컬 서버는 비워 두세요"
                        : "공급자가 발급한 키"
                  }
                />
              </label>
              {view.needsKey && <small>이전에 등록한 키를 다시 입력하세요.</small>}
              <small>
                {view.persistentKeys
                  ? "입력한 키는 이 Windows 계정에 암호화해 저장합니다."
                  : "입력한 키는 서버를 종료할 때까지 사용합니다. 재시작하면 다시 입력하세요."}
              </small>
              {(view.hasKey || view.needsKey) && (
                <label className="remove-provider-key">
                  <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
                  저장 시 기존 키 제거
                </label>
              )}
              {!enabled && (
                <label>
                  기본 모델 ID
                  <input
                    value={model}
                    maxLength={256}
                    placeholder="공급자의 모델 ID (선택)"
                    onChange={(e) => setModel(e.target.value)}
                  />
                </label>
              )}
              <button type="submit">연결 저장</button>
            </fieldset>
          </form>
        )}
      </details>
      {children}
      {enabled && view && (
        <div className="default-model">
          <small>공급자 기본 모델 · {view.defaultModel || "미지정"}</small>
          {selectedModel &&
            selectedModel !== view.defaultModel &&
            isModelSelection({ provider, model: selectedModel }) && (
              <button type="button" disabled={locked} onClick={() => void save(selectedModel)}>
                선택 모델을 기본값으로 저장
              </button>
            )}
          {view.defaultModel && (
            <button type="button" disabled={locked} onClick={() => void save("")}>
              기본값 해제
            </button>
          )}
        </div>
      )}
      {message && <output>{message}</output>}
      {message && (!view || message.includes("다른 창")) && (
        <button type="button" onClick={() => reload((n) => n + 1)}>
          연결 설정 다시 읽기
        </button>
      )}
    </>
  );
}
