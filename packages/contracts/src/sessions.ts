export const presets = { general: "일반", coding: "코딩", research: "조사", writing: "글쓰기" } as const;
export type Preset = keyof typeof presets;
export function isPreset(value: unknown): value is Preset {
  return typeof value === "string" && Object.hasOwn(presets, value);
}

export interface Session {
  id: string;
  title: string;
  preset: Preset;
}

export interface Turn {
  id: string;
  message: string;
  reply: string;
  status: "streaming" | "completed" | "cancelled" | "failed" | "interrupted";
  preset: Preset;
}
