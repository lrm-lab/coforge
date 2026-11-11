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

/** Which Kiro sign-in a person asked for: the identity-center one (`pro`), or Builder ID and the
 * social providers, which `kiro-cli` calls the free license. */
export type KiroLicense = "pro" | "free";

/** A Kiro sign-in as the adapter needs it: the license, and for `pro` the identity center it must
 * land on. `free` carries no identity center, and one sent with it is refused rather than ignored. */
export type KiroLoginTarget = Readonly<
  { license: "free" } | { license: "pro"; identityCenter: KiroIdentityCenterOptions }
>;

/**
 * Validates Kiro's two sign-in shapes together, since either one alone is ambiguous: no license
 * with an identity center is a `pro` sign-in from a server that predates the choice, and a `free`
 * sign-in must not name an identity center at all.
 */
export function runtimeAuthKiroLogin(
  provider: string,
  identityCenter: unknown,
  license: unknown,
): KiroLoginTarget | undefined {
  if (provider !== RUNTIME_PROVIDER.KIRO) {
    if (identityCenter !== undefined || license !== undefined)
      throw new Error("Kiro sign-in options belong to Kiro only");
    return undefined;
  }
  if (license === "free") {
    if (identityCenter !== undefined)
      throw new Error("A free Kiro sign-in names no identity center");
    return { license: "free" };
  }
  if (license !== undefined && license !== "pro") throw new Error("Invalid Kiro license");
  return { license: "pro", identityCenter: parseKiroIdentityCenterOptions(identityCenter) };
}

const ANTIGRAVITY_METHODS = new Set(["oauth-personal", "oauth-business"]);
export function runtimeAuthAntigravityMethod(
  provider: string,
  value: unknown,
): "oauth-personal" | "oauth-business" | undefined {
  if (provider !== RUNTIME_PROVIDER.ANTIGRAVITY) {
    if (value !== undefined)
      throw new Error("Antigravity account choice belongs to Antigravity only");
    return undefined;
  }
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ANTIGRAVITY_METHODS.has(value))
    throw new Error("Invalid Antigravity account choice");
  return value as "oauth-personal" | "oauth-business";
}
