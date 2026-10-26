import { RUNTIME_PROVIDER } from "./runtime-provider";
/** The native IAM Identity Center login target, carried only for one sign-in. */
export type KiroIdentityCenterOptions = Readonly<{ startUrl: string; region: string }>;

export function parseKiroIdentityCenterOptions(value: unknown): KiroIdentityCenterOptions {
  if (typeof value !== "object" || value === null)
    throw new Error("Kiro enterprise target required");
  const { startUrl, region } = value as Record<string, unknown>;
  if (typeof startUrl !== "string" || startUrl.length > 2048 || /[\p{Cc}\p{Cf}\s]/u.test(startUrl))
    throw new Error("Invalid Kiro Start URL");
  let url: URL;
  try {
    url = new URL(startUrl);
  } catch {
    throw new Error("Invalid Kiro Start URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
    throw new Error("Invalid Kiro Start URL");
  if (
    typeof region !== "string" ||
    region.length > 64 ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d+$/u.test(region)
  )
    throw new Error("Invalid AWS Region");
  return { startUrl, region };
}

export function runtimeAuthKiroOptions(
  provider: string,
  value: unknown,
): KiroIdentityCenterOptions | undefined {
  if (provider === RUNTIME_PROVIDER.KIRO) return parseKiroIdentityCenterOptions(value);
  if (value !== undefined) throw new Error("Kiro enterprise target belongs to Kiro only");
  return undefined;
}
