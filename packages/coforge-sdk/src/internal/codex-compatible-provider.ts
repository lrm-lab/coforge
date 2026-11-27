import { RUNTIME_PROVIDER } from "./runtime-provider";

export const CODEX_COMPATIBLE_MODEL_PROVIDER = "openai-compatible";
export const CODEX_COMPATIBLE_PROVIDER_CAPABILITY = "codex-compatible-provider:v1";

export function selectsCodexCompatible(runtime: string, modelProvider?: string): boolean {
  return runtime === RUNTIME_PROVIDER.CODEX && modelProvider === CODEX_COMPATIBLE_MODEL_PROVIDER;
}

export type CodexCompatibleEnvironment = Readonly<{
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL: string;
}>;

export function codexCompatibleBaseUrl(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (
    !trimmed ||
    trimmed.length > 2048 ||
    !/^https?:\/\/[^/]+/i.test(trimmed) ||
    /[\p{Cc}\s\\?#]/u.test(trimmed) ||
    /^https?:\/\/[^/]*@/i.test(trimmed)
  )
    return undefined;
  return URL.parse(trimmed)?.href;
}

export function codexCompatibleEnvironment(value: unknown): CodexCompatibleEnvironment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const url = codexCompatibleBaseUrl(Reflect.get(value, "OPENAI_BASE_URL"));
  const rawKey = Reflect.get(value, "OPENAI_API_KEY");
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!url || !key || key.length > 4096 || /[\p{Cc}\s]/u.test(key)) return undefined;
  return { OPENAI_API_KEY: key, OPENAI_BASE_URL: url };
}
