import { useState, type FormEvent } from "react";
import {
  providerNames,
  type ProviderId,
  type ProviderOption,
  type ModelSelection,
} from "../../../packages/contracts/src/providers.ts";

export function ModelPicker({
  selection,
  options,
  disabled,
  save,
}: {
  selection: ModelSelection;
  options: ProviderOption[];
  disabled: boolean;
  save: (s: ModelSelection) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(selection.provider);
  const [model, setModel] = useState(selection.model);
  const option = options.find((o) => o.id === provider);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await save({ provider, model: provider === "mock" ? "" : model.trim() })) setOpen(false);
  }
  return (
    <div className="model-picker">
      <button
        type="button"
        className="model-label"
        aria-expanded={open}
        aria-label="모델 설정"
        disabled={disabled}
        onClick={() => {
          setProvider(selection.provider);
          setModel(selection.model);
          setOpen(!open);
        }}
      >
        {providerNames[selection.provider]}
        {selection.model && ` · ${selection.model}`} ▾
      </button>
      {open && (
        <form className="model-form" onSubmit={submit}>
          <label>
            공급자
            <select
              aria-label="공급자"
              value={provider}
              disabled={disabled}
              onChange={(e) => {
                const next = e.target.value as ProviderId;
                setProvider(next);
                setModel(
                  next === selection.provider
                    ? selection.model
                    : (options.find((o) => o.id === next)?.defaultModel ?? ""),
                );
              }}
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {providerNames[o.id]}
                </option>
              ))}
            </select>
          </label>
          {provider !== "mock" && (
            <>
              <label>
                모델 ID
                <input required maxLength={256} value={model} onChange={(e) => setModel(e.target.value)} />
              </label>
              <small>
                {option?.enabled
                  ? "전송 시 이 세션의 최근 완료 대화도 함께 전달됩니다."
                  : provider === "openrouter"
                    ? "서버에 AGS_OPENROUTER_API_KEY를 설정하고 다시 시작하세요."
                    : "서버에 AGS_CUSTOM_BASE_URL을 설정하고 다시 시작하세요."}
              </small>
            </>
          )}
          <button
            type="submit"
            disabled={
              disabled || !option?.enabled || (provider !== "mock" && !/^[!-~]{1,256}$/.test(model.trim()))
            }
          >
            적용
          </button>
        </form>
      )}
    </div>
  );
}
