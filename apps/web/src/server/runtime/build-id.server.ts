export const DEFAULT_BUILD_ID = "development";

export function readBuildId(environment: Record<string, string | undefined> = process.env): string {
  return environment.COFORGE_BUILD_ID?.trim() || DEFAULT_BUILD_ID;
}
