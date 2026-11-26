import { useEffect, useState } from "react";
import {
  maxReferenceChars,
  type Section,
  type Project,
  type FilePage,
} from "../../../packages/contracts/src/workspace.ts";
import { api, SearchResultChanged } from "./api.ts";

export function SectionStateSource({
  token,
  project,
  section,
  path,
  file,
  refresh,
}: {
  token: string;
  project: Project;
  section: Section;
  path: string;
  file: FilePage | undefined;
  refresh: (id: string) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const eligible =
    file &&
    file.start === 1 &&
    file.end === file.total &&
    !file.clipped &&
    file.text.trim() &&
    file.text.length <= maxReferenceChars;
  async function save(version: string | null) {
    setBusy(true);
    setError("");
    try {
      await api(token, `/api/projects/${project.id}/state-source`, "POST", {
        root: project.root,
        section: section.id,
        previous: section.stateKey,
        path,
        version,
      });
      await refresh(project.id);
    } catch (e) {
      setError(
        e instanceof SearchResultChanged
          ? "원본이 바뀌었습니다. 최신 파일을 다시 열고 지정하세요."
          : e instanceof Error
            ? e.message
            : "상태 파일을 지정하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="section-state">
      <summary>섹션 현재 상태{section.statePath ? ` · ${section.statePath}` : ""}</summary>
      <p>목표·결정·다음 할 일을 적은 파일을 지정하면 이 섹션의 대화에서 참고합니다.</p>
      {file &&
        (eligible ? (
          <button
            type="button"
            disabled={busy || (path === section.statePath && file.version === section.stateVersion)}
            onClick={() => void save(file.version)}
          >
            {path === section.statePath && file.version !== section.stateVersion
              ? "현재 버전으로 상태 갱신"
              : "현재 파일을 상태로 지정"}
          </button>
        ) : (
          <small>
            첫 줄부터 전체가 보이는 80줄·6,000자 이내의 문서를 여세요. 한 줄은 2,048자까지 지원합니다.
          </small>
        ))}
      {section.stateKey && (
        <button type="button" disabled={busy} onClick={() => void save(null)}>
          상태 파일 지정 해제
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}

export function SectionMemorySetting({ token }: { token: string }) {
  return (
    <>
      <MemoryToggle
        token={token}
        path="/api/settings/section-memory"
        label="섹션 기억 참조"
        detail="지정한 상태 파일과 최근 구간 요약을 같은 섹션의 대화에 포함합니다."
      />
      <MemoryToggle
        token={token}
        path="/api/settings/memory-update"
        label="작업기억 갱신"
        detail="대화에서 구간 요약 초안을 만들고 검토한 내용을 작업 폴더에 저장할 수 있습니다."
      />
    </>
  );
}
function MemoryToggle({
  token,
  path,
  label,
  detail,
}: {
  token: string;
  path: string;
  label: string;
  detail: string;
}) {
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api(token, path, "GET", undefined, controller.signal)
      .then((r) => r.json())
      .then((data) => {
        if (!controller.signal.aborted) setEnabled(data.enabled);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [token, path]);
  async function toggle() {
    setBusy(true);
    setError("");
    try {
      const data = await (await api(token, path, "PUT", { enabled: !enabled })).json();
      setEnabled(data.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : "설정을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={enabled === undefined || busy}
          onChange={() => void toggle()}
        />
        {label}
      </label>
      <p>{detail}</p>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
