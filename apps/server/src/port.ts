export function localPort(value: string | undefined) {
  const raw = value?.trim() || "4317";
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error("invalid_port");
  return Number(raw);
}
