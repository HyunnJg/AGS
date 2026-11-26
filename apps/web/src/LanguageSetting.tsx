import { useEffect, useState } from "react";
import {
  isResponseLanguage,
  responseLanguages,
  type ResponseLanguage,
} from "../../../packages/contracts/src/context.ts";
import { api, SettingsConflict } from "./api.ts";

const path = "/api/settings/response-language";

export function LanguageSetting({ token }: { token: string }) {
  const [saved, setSaved] = useState<ResponseLanguage>();
  const [draft, setDraft] = useState<ResponseLanguage>("auto");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [attempt, reload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    if (attempt) setMessage("최신 언어 설정을 읽는 중…");
    api(token, path, "GET", undefined, controller.signal)
      .then((r) => r.json())
      .then(({ language }) => {
        if (controller.signal.aborted) return;
        setSaved(language);
        setDraft(language);
        setMessage("");
      })
      .catch(() => {
        if (!controller.signal.aborted) setMessage("언어 설정을 읽지 못했습니다.");
      });
    return () => controller.abort();
  }, [token, attempt]);
  async function save() {
    if (!saved) return;
    setBusy(true);
    try {
      await api(token, path, "PUT", { language: draft, previous: saved });
      setSaved(draft);
      setMessage("기본 응답 언어를 저장했습니다.");
    } catch (error) {
      if (error instanceof SettingsConflict) setSaved(undefined);
      setMessage(error instanceof Error ? error.message : "언어 설정을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        기본 응답 언어
        <select
          disabled={!saved || busy}
          value={draft}
          onChange={(e) => {
            if (isResponseLanguage(e.target.value)) setDraft(e.target.value);
            setMessage("");
          }}
        >
          {Object.entries(responseLanguages).map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <small>
        공급자 채팅과 독립 검토에 적용합니다. 자동을 선택하면 언어 지침을 생략합니다. 요청마다 다른 언어를
        지정할 수 있습니다.
      </small>
      <footer>
        <button className="primary" type="submit" disabled={!saved || busy || saved === draft}>
          저장
        </button>
        {!saved && message && (
          <button type="button" onClick={() => reload((n) => n + 1)}>
            최신 언어 설정 불러오기
          </button>
        )}
      </footer>
      {message && <output>{message}</output>}
    </form>
  );
}
