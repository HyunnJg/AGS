import { PresetLibrary } from "./PresetLibrary.tsx";
import { LanguageSetting } from "./LanguageSetting.tsx";
import { CallLogs } from "./CallLogs.tsx";
import { ProviderConnection } from "./ProviderConnection.tsx";
import { SectionMemorySetting } from "./SectionMemory.tsx";
import { DisplayRules } from "./DisplayRules.tsx";
import type { DisplayRule } from "../../../packages/contracts/src/display.ts";
import { SharedPrompt } from "./PromptLayout.tsx";
import { ContextSettings } from "./ContextSettings.tsx";
import type { Session } from "../../../packages/contracts/src/sessions.ts";
import { useEffect, useRef, useState } from "react";
import {
  isModelSelection,
  providerNames,
  type CatalogModel,
  type ModelSelection,
  type ProviderId,
  type ProviderOption,
} from "../../../packages/contracts/src/providers.ts";
import { api } from "./api.ts";

function ModelList({
  token,
  provider,
  model,
  choose,
}: {
  token: string;
  provider: ProviderId;
  model: string;
  choose: (id: string) => void;
}) {
  const [rows, setRows] = useState<CatalogModel[]>([]);
  const [favorites, setFavorites] = useState<ModelSelection[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"loading" | "failed" | "ready">("loading");
  const [catalogError, setCatalogError] = useState("");
  const [attempt, retry] = useState(0);
  const [pinning, setPinning] = useState(true);
  const [pinError, setPinError] = useState("");
  useEffect(() => {
    let current = true;
    setStatus("loading");
    api(token, `/api/providers/${provider}/models${attempt ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then((data) => {
        if (current) {
          setRows(data);
          setStatus("ready");
        }
      })
      .catch(error => {
        if (current) { setCatalogError(error instanceof Error ? error.message : "모델 목록을 읽지 못했습니다."); setStatus("failed"); }
      });
    return () => {
      current = false;
    };
  }, [token, provider, attempt]);
  useEffect(() => {
    let current = true;
    api(token, "/api/settings/favorites")
      .then((r) => r.json())
      .then((data) => {
        if (current) setFavorites(data);
      })
      .catch(() => {
        if (current) setPinError("즐겨찾기를 읽지 못했습니다.");
      })
      .finally(() => {
        if (current) setPinning(false);
      });
    return () => {
      current = false;
    };
  }, [token]);
  const pins = new Set(favorites.filter((f) => f.provider === provider).map((f) => f.model));
  const all = new Map(rows.map((r) => [r.id, r]));
  for (const id of pins) if (!all.has(id)) all.set(id, { id, name: id });
  const search = query.trim().toLowerCase();
  const matches = [...all.values()]
    .filter((r) => `${r.name} ${r.id}`.toLowerCase().includes(search))
    .sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || a.name.localeCompare(b.name));
  async function toggle(id: string) {
    setPinning(true);
    setPinError("");
    try {
      setFavorites(
        await (
          await api(token, "/api/settings/favorites", "PUT", { provider, model: id, pinned: !pins.has(id) })
        ).json(),
      );
    } catch {
      setPinError("즐겨찾기를 저장하지 못했습니다.");
    } finally {
      setPinning(false);
    }
  }
  return (
    <div className="catalog">
      {provider === "anthropic" && <small>Claude API의 워크스페이스 전용 키를 사용하세요. 최대 출력을 비워 두면 채팅당 4,096토큰을 요청합니다.</small>}
      {provider === "gemini" && <small>Gemini Developer API의 콘텐츠 생성 모델입니다. 텍스트 응답을 지원하는 모델을 선택하세요.</small>}
      {provider === "openai" && <small>계정에서 사용할 수 있는 모델 목록입니다. 텍스트 채팅에는 Chat Completions 지원 모델을 선택하세요.</small>}
      <label>
        모델 검색
        <input
          form="apply-chat-model"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="이름 또는 모델 ID"
        />
      </label>
      {status === "ready" && (
        <button type="button" className="refresh-models" onClick={() => retry((n) => n + 1)}>
          목록 새로고침
        </button>
      )}
      {status === "loading" && <output>목록을 불러오는 중…</output>}
      {status === "failed" && (
        <div className="catalog-error">
          {catalogError}{" "}
          <button type="button" onClick={() => retry((n) => n + 1)}>
            다시 조회
          </button>
        </div>
      )}
      {status === "ready" && !matches.length && (
        <small>{search ? "검색 결과가 없습니다." : "공급자가 반환한 모델이 없습니다."}</small>
      )}
      {!!matches.length && (
        <ul aria-label="모델 목록">
          {matches.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="model-row"
                aria-pressed={model === row.id}
                onClick={() => choose(row.id)}
              >
                <strong>{row.name}</strong>
                {row.name !== row.id && <small>{row.id}</small>}
                {row.contextLength && <small>컨텍스트 {row.contextLength.toLocaleString()} 토큰</small>}
              </button>
              <button
                type="button"
                className="pin"
                aria-label={`${row.id} 즐겨찾기`}
                aria-pressed={pins.has(row.id)}
                disabled={pinning}
                onClick={() => void toggle(row.id)}
              >
                {pins.has(row.id) ? "★" : "☆"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <label>
        모델 ID
        <input form="apply-chat-model" required maxLength={256} value={model} onChange={(e) => choose(e.target.value)} />
      </label>
      {!all.has(model.trim()) && isModelSelection({ provider, model: model.trim() }) && (
        <button type="button" disabled={pinning} onClick={() => void toggle(model.trim())}>
          이 ID 즐겨찾기
        </button>
      )}
      {pinError && <small role="alert">{pinError}</small>}
    </div>
  );
}

function Runtime({ token }: { token: string }) {
  const [runtime, setRuntime] = useState<{
    idleTimeoutMs: number;
    totalTimeoutMs: number;
    stateDirectory: string;
  }>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let current = true;
    api(token, "/api/settings/runtime")
      .then((r) => r.json())
      .then((data) => {
        if (current) setRuntime(data);
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
    };
  }, [token]);
  if (error) return <p role="alert">서버 설정을 읽지 못했습니다.</p>;
  if (!runtime) return <output>불러오는 중…</output>;
  return (
    <dl className="runtime">
      <dt>대화 저장 폴더</dt>
      <dd>{runtime.stateDirectory}</dd>
      <dt>유휴 시간 제한</dt>
      <dd>{runtime.idleTimeoutMs / 1000}초</dd>
      <dt>요청 전체 시간 제한</dt>
      <dd>{runtime.totalTimeoutMs / 1000}초</dd>
    </dl>
  );
}

export function SettingsCenter({
  token,
  selection,
  options,
  onOptions,
  close,
  save,
  session,
  onRulesSaved,
  draft,
  streaming,
}: {
  token: string;
  selection: ModelSelection;
  options: ProviderOption[];
  onOptions: (options: ProviderOption[]) => void;
  close: () => void;
  save: (value: ModelSelection) => Promise<void>;
  session?: Session;
  onRulesSaved: (rules: DisplayRule[]) => void;
  draft: string;
  streaming: boolean;
}) {
  const sessionTitle = session?.title;
  const [tab, setTab] = useState("공급사 · 모델");
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState("모델");
  const [provider, setProvider] = useState(selection.provider);
  const [model, setModel] = useState(selection.model);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [catalogVersion, refreshCatalog] = useState(0);
  const enabled = options.some((o) => o.id === provider && o.enabled);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  async function apply() {
    setSaving(true);
    setError("");
    try {
      await save({ provider, model: model.trim() });
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "모델을 적용하지 못했습니다.");
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="settings-heading"
      className="settings-center"
      onCancel={(e) => {
        e.preventDefault();
        if (!saving) close();
      }}
    >
      <header>
        <h2 id="settings-heading">설정</h2>
        <button type="button" disabled={saving} aria-label="설정 닫기" onClick={close}>
          닫기
        </button>
      </header>
      <div className="settings-layout">
        <fieldset disabled={saving} className="settings-rail" aria-label="설정 분류">
          {["모델", "임베딩", "이미지", "TTS", "언어 지원", "고급 기능", "플러그인", "토글형 모듈", "호출 로그"].map(
            (item) => (
              <button
                type="button"
                key={item}
                disabled={!["모델", "언어 지원", "고급 기능", "토글형 모듈", "호출 로그"].includes(item)}
                title={["모델", "언어 지원", "고급 기능", "토글형 모듈", "호출 로그"].includes(item) ? undefined : "연결 예정"}
                aria-pressed={section === item}
                onClick={() => setSection(item)}
              >
                {item}
              </button>
            ),
          )}
        </fieldset>
        <section className="settings-detail">
          {section === "모델" ? (
            <fieldset disabled={saving} className="settings-tabs" aria-label="모델 설정 항목">
              {["공급사 · 모델", "컨텍스트 제어", "공용 프롬프트", "분야 프리셋", "정규식"].map((item) => (
                <button key={item} type="button" aria-pressed={tab === item} onClick={() => setTab(item)}>
                  {item}
                </button>
              ))}
            </fieldset>
          ) : (
            <h3>{section === "고급 기능" ? "로컬 서버" : section}</h3>
          )}
          {section === "모델" && tab === "분야 프리셋" ? (
            <PresetLibrary token={token} />
          ) : section === "모델" && tab === "정규식" ? (
            <DisplayRules token={token} onSaved={onRulesSaved} />
          ) : section === "모델" && tab === "공용 프롬프트" ? (
            <SharedPrompt token={token} session={session} />
          ) : section === "모델" && tab === "컨텍스트 제어" ? (
            session ? (
              <ContextSettings key={session.id} session={session} token={token} draft={draft} />
            ) : (
              <small>대화를 시작하면 이 대화의 컨텍스트를 설정할 수 있습니다.</small>
            )
          ) : section === "모델" ? (
            <>
              {sessionTitle && <small>적용할 대화 · {sessionTitle}</small>}
              <fieldset disabled={saving} className="provider-pills" aria-label="공급자">
                <legend>공급자</legend>
                {options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    aria-pressed={provider === o.id}
                    onClick={() => {
                      setProvider(o.id);
                      setError("");
                      setModel(o.id === selection.provider ? selection.model : o.defaultModel);
                    }}
                  >
                    {providerNames[o.id]}
                  </button>
                ))}
              </fieldset>
              {provider !== "mock" && (
                <ProviderConnection
                  key={provider}
                  provider={provider}
                  token={token}
                  enabled={enabled}
                  locked={saving}
                  selectedModel={model.trim()}
                  onBusy={setSaving}
                  onSave={(choices, next, previous, connectionChanged) => {
                    onOptions(choices);
                    if (connectionChanged) {
                      if (!model || model === previous) setModel(next);
                      refreshCatalog((n) => n + 1);
                    }
                  }}
                >
                  {enabled && (
                    <ModelList
                      key={provider + catalogVersion}
                      token={token}
                      provider={provider}
                      model={model}
                      choose={setModel}
                    />
                  )}
                </ProviderConnection>
              )}
              <form
                id="apply-chat-model"
                onSubmit={(e) => {
                  e.preventDefault();
                  void apply();
                }}
              >
                {provider === "mock" && <small>API 키 없이 응답을 확인하는 로컬 테스트 모델입니다.</small>}
                {error && <p role="alert">{error}</p>}
                {streaming && <small>이 대화의 응답이 끝나면 모델을 변경할 수 있습니다.</small>}
                <footer>
                  <button
                    type="submit"
                    className="primary"
                    disabled={
                      saving || streaming || !enabled || !isModelSelection({ provider, model: model.trim() })
                    }
                  >
                    {sessionTitle ? "적용" : "이 모델로 대화 시작"}
                  </button>
                </footer>
              </form>
            </>
          ) : section === "언어 지원" ? (
            <LanguageSetting token={token} />
          ) : section === "호출 로그" ? (
            <CallLogs token={token} />
          ) : section === "토글형 모듈" ? (
            <SectionMemorySetting token={token} />
          ) : (
            <Runtime token={token} />
          )}
        </section>
      </div>
    </dialog>
  );
}
