export interface DisplayRule {
  id: string;
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
  enabled: boolean;
}
export interface DisplaySettings {
  revision: number;
  rules: DisplayRule[];
}
export const maxRules = 12;
export const maxText = 65536;
export function ruleError(rules: unknown): string {
  if (!Array.isArray(rules) || rules.length > maxRules) return "규칙은 최대 12개까지 저장할 수 있습니다.";
  const ids = new Set<string>();
  for (const r of rules) {
    if (
      !r ||
      typeof r.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(r.id) ||
      ids.has(r.id) ||
      typeof r.name !== "string" ||
      !r.name.trim() ||
      r.name.length > 64 ||
      typeof r.enabled !== "boolean"
    )
      return "규칙 이름과 식별자를 확인하세요.";
    ids.add(r.id);
    if (
      typeof r.pattern !== "string" ||
      !r.pattern ||
      r.pattern.length > 256 ||
      typeof r.replacement !== "string" ||
      r.replacement.length > 512
    )
      return `${r.name}: 패턴은 1~256자, 치환문은 최대 512자입니다.`;
    if (typeof r.flags !== "string" || !/^[gimsu]{0,5}$/.test(r.flags))
      return `${r.name}: 플래그는 g, i, m, s, u를 지원합니다.`;
    try {
      new RegExp(r.pattern, r.flags);
    } catch {
      return `${r.name}: 정규식 문법이나 플래그를 확인하세요.`;
    }
  }
  return "";
}
