/**
 * Q160-B on the current OpenViking public path.
 *
 * Coforge Episode and Insight are not candidates, anchors, or offer sources
 * for a new discovery or serve. Skill revisions stay eligible. This module
 * does not delete stored rows; a later offer rechecks the citation it would
 * publish and refuses a retired object without rewriting the old record.
 */

export const RETIRED_FROM_MEMORY_DISCOVERY = "retired_from_memory_discovery";

const RETIRED_TOKENS = new Set(["episode", "episodes", "insight", "insights", "episodeinsight"]);

export class RetiredFromMemoryDiscoveryError extends Error {
  readonly code = RETIRED_FROM_MEMORY_DISCOVERY;

  constructor() {
    super(RETIRED_FROM_MEMORY_DISCOVERY);
    this.name = "RetiredFromMemoryDiscoveryError";
  }
}

export function isRetiredFromMemoryDiscovery(value: unknown): boolean {
  if (typeof value === "string") return retiredString(value);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const key of ["kind", "category", "corpus", "relation", "relationType", "uri"]) {
    const field = record[key];
    if (typeof field === "string" && retiredString(field)) return true;
  }
  return false;
}

export function assertDiscoveryServable(value: unknown): void {
  if (isRetiredFromMemoryDiscovery(value)) throw new RetiredFromMemoryDiscoveryError();
}

function retiredString(value: string): boolean {
  if (RETIRED_TOKENS.has(fold(value))) return true;
  const path = value.split(/[?#]/, 1)[0] ?? value;
  return path.split("/").some((part) => RETIRED_TOKENS.has(fold(part)));
}

function fold(value: string): string {
  return value.replace(/[_-]/g, "").toLowerCase();
}
