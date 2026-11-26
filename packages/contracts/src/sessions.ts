import type { ModelSelection } from "./providers.ts";

export const presets = { general: "일반", coding: "코딩", research: "조사", writing: "글쓰기" } as const;
export type BuiltinPreset = keyof typeof presets;
export type CustomPresetId = `custom-${string}`;
export type Preset = BuiltinPreset | CustomPresetId;
export interface CustomPresetSummary {
  id: CustomPresetId;
  name: string;
}
export interface CustomPreset extends CustomPresetSummary {
  instructions: string;
}
export const maxPresetName = 80;
export const maxPresetText = 8000;
export function isCustomPresetId(value: unknown): value is CustomPresetId {
  return typeof value === "string" && /^custom-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}
export function isBuiltinPreset(value: unknown): value is BuiltinPreset {
  return typeof value === "string" && Object.hasOwn(presets, value);
}

export function isPreset(value: unknown): value is Preset {
  return isBuiltinPreset(value) || isCustomPresetId(value);
}
export function normalizePresetText(text: string) {
  return text.replace(/\r\n?/g, "\n");
}
export function isPresetDraft(value: unknown): value is Pick<CustomPreset, "name" | "instructions"> {
  if (!value || typeof value !== "object" || !("name" in value) || !("instructions" in value)) return false;
  const { name, instructions } = value;
  return typeof name === "string" && name.length <= maxPresetName && !!name.trim() &&
    name.isWellFormed() && !name.includes("\0") &&
    typeof instructions === "string" && normalizePresetText(instructions).length <= maxPresetText && !!instructions.trim() &&
    instructions.isWellFormed() && !instructions.includes("\0");
}

export interface Session extends ModelSelection {
  sectionId?: string | null;
  sectionLabel?: string | null;
  id: string;
  title: string;
  preset: Preset;
}

export interface Turn extends ModelSelection {
  id: string;
  message: string;
  reply: string;
  status: "streaming" | "completed" | "cancelled" | "failed" | "interrupted";
  preset: Preset;
}
