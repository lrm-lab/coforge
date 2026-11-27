import { AGENT_NAME_MAX_LENGTH, freeAgentName } from "@lrm/coforge-sdk/internal";
import { adjectives, animals, uniqueNamesGenerator } from "unique-names-generator";

const MAX_GENERATION_ATTEMPTS = 64;
const SEED_STRIDE = 7919;

export function typedAgentUsername(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-/, "")
    .slice(0, AGENT_NAME_MAX_LENGTH);
}

export function finishedAgentUsername(text: string): string {
  return typedAgentUsername(text).replace(/-+$/, "");
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function generatedCandidate(seed: number): string {
  return finishedAgentUsername(
    uniqueNamesGenerator({
      dictionaries: [adjectives, animals],
      separator: "-",
      style: "lowerCase",
      length: 2,
      seed,
    }),
  );
}

function seedFromRandom(random: () => number, attempt: number): number {
  const base = Math.floor(Math.abs(random()) * 0x7fffffff);
  return (base + attempt * SEED_STRIDE) >>> 0;
}

export function randomAgentUsername(
  current?: string,
  random: () => number = Math.random,
  taken: ReadonlySet<string> = new Set(),
  seen: ReadonlySet<string> = new Set(),
): string {
  let fallbackFree: string | undefined;
  let lastCandidate = "";
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    const candidate = generatedCandidate(seedFromRandom(random, attempt));
    if (!candidate) continue;
    lastCandidate = candidate;
    if (candidate === current || taken.has(candidate)) continue;
    if (!seen.has(candidate)) return candidate;
    if (!fallbackFree) fallbackFree = candidate;
  }
  if (fallbackFree) return fallbackFree;
  const base = lastCandidate && lastCandidate !== current ? lastCandidate : "agent";
  return availableAgentUsername(base, taken, current);
}

export function availableAgentUsername(
  name: string,
  taken: ReadonlySet<string>,
  skip?: string,
): string {
  if (!taken.has(name)) return name;
  const baseSeed = hashSeed(name);
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const candidate = generatedCandidate((baseSeed + attempt * SEED_STRIDE) >>> 0);
    if (candidate && candidate !== skip && !taken.has(candidate)) return candidate;
  }
  return freeAgentName(name, taken);
}
