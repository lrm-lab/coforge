/**
 * Who of the busy Agents stands on the chat list header's stage, as a pure step function: the
 * stage feeds it the busy Agents (most relevant first), how many fit, the clock and a random
 * source, and reports when an entrance or an exit has finished. The rest wait off stage, behind
 * the count.
 *
 * - The first step puts the most relevant Agents straight on stage.
 * - An Agent that stops leaves and, while it stays stopped, never comes back.
 * - While someone waits, an Agent past its stay leaves; one at a time, never one the viewer is
 *   holding (pointing at, or reading its card). After an exit, the next comes out after a short
 *   gap; between entrances there is a longer one.
 * - The next to come out is a newly busy Agent first, else the one shown least recently, with
 *   relevance and a little randomness to break near ties.
 * - With reduced motion the stage holds the most relevant Agents still and nothing rotates.
 */

import { between, type Random } from "./busy-agents-random";

export const CAST_TIMING = {
  /** How long an Agent stays on stage before it may make room. */
  stayMs: [14_000, 40_000],
  /** The wait between two entrances. */
  gapMs: [4_000, 12_000],
  /** The wait after an exit before the next comes out. */
  afterLeaveMs: [1_200, 5_000],
  /** No Agent leaves to make room sooner than this after coming out. */
  minOnMs: 8_000,
} as const;

/** The stage's width per mascot, and how many it holds at least and at most. */
const SLOT_PX = 34;
const MIN_ON_STAGE = 3;
const MAX_ON_STAGE = 5;
/** How much relevance is worth against time since an Agent was last shown, and the random jitter. */
const RANK_WEIGHT_MS = 1_500;
const JITTER_MS = 8_000;
/** A newly busy Agent comes out this soon when there is room for it. */
const FRESH_ENTRY_MS = 600;

export type CastPhase = "entering" | "on" | "leaving";
export type CastMember = { id: string; phase: CastPhase; since: number; stay: number };

export type CastState = {
  /** On stage, in the order they came on. Leaving ones are still there until they arrive. */
  members: readonly CastMember[];
  /** When each Agent last left the stage. */
  lastShown: ReadonlyMap<string, number>;
  /** The busy Agents that were there at the start or have had a turn on stage; a busy one not in
   * it is newly busy, until it has had its turn (one that went idle and returns included). */
  seen: ReadonlySet<string>;
  nextEntryAt: number;
  started: boolean;
};

export type CastInput = {
  /** The busy Agents' ids, most relevant first. */
  busy: readonly string[];
  /** How many mascots the stage holds (`stageCapacity`). */
  capacity: number;
  now: number;
  /** Agents the viewer is pointing at or reading the card of: they stay. */
  held: ReadonlySet<string>;
  reduced: boolean;
};

/** How many mascots fit a stage `width` pixels wide. */
export function stageCapacity(width: number): number {
  return Math.min(MAX_ON_STAGE, Math.max(MIN_ON_STAGE, Math.floor(width / SLOT_PX)));
}

export function initialCast(): CastState {
  return { members: [], lastShown: new Map(), seen: new Set(), nextEntryAt: 0, started: false };
}

/** The busy Agents not on stage: the number the count shows. */
export function waitingCount(members: readonly CastMember[], busy: readonly string[]): number {
  const on = new Set(members.map((member) => member.id));
  return busy.filter((id) => !on.has(id)).length;
}

/** An entering Agent is fully out. */
export function castEntered(state: CastState, id: string, now: number): CastState {
  return {
    ...state,
    members: state.members.map((member) =>
      member.id === id && member.phase === "entering"
        ? { ...member, phase: "on", since: now }
        : member,
    ),
  };
}

/** A leaving Agent is gone behind the count. */
export function castArrived(
  state: CastState,
  id: string,
  now: number,
  random: Random = Math.random,
): CastState {
  if (!state.members.some((member) => member.id === id)) return state;
  return {
    ...state,
    members: state.members.filter((member) => member.id !== id),
    lastShown: new Map(state.lastShown).set(id, now),
    nextEntryAt: now + between(...CAST_TIMING.afterLeaveMs, random),
  };
}

export function stepCast(state: CastState, input: CastInput, random: Random): CastState {
  const { busy, now, held } = input;
  const room = Math.min(input.capacity, busy.length);
  if (input.reduced) return stillCast(state, input);
  if (!state.started) {
    // Staggered stays, so the first exits do not all come due together.
    const members = busy.slice(0, input.capacity).map((id, index) => ({
      id,
      phase: "on" as const,
      since: now,
      stay: between(...CAST_TIMING.stayMs, random) + index * 6_000,
    }));
    return {
      ...state,
      members,
      seen: new Set(busy),
      nextEntryAt: now + between(...CAST_TIMING.gapMs, random),
      started: true,
    };
  }
  const isBusy = new Set(busy);
  const rank = new Map(busy.map((id, index) => [id, index]));
  let members = state.members.map((member) =>
    !isBusy.has(member.id) && member.phase !== "leaving"
      ? { ...member, phase: "leaving" as const, since: now }
      : member,
  );
  // A narrower stage (or fewer busy Agents) sends the least relevant off.
  const staying = members.filter((member) => member.phase !== "leaving");
  if (staying.length > room) {
    const extra = new Set(
      [...staying]
        .sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0))
        .slice(0, staying.length - room)
        .map((member) => member.id),
    );
    members = members.map((member) =>
      extra.has(member.id) ? { ...member, phase: "leaving" as const, since: now } : member,
    );
  }
  const onStage = new Set(members.map((member) => member.id));
  const waiting = busy.filter((id) => !onStage.has(id));
  const fresh = waiting.filter((id) => !state.seen.has(id));
  let nextEntryAt = state.nextEntryAt;
  if (fresh.length) nextEntryAt = Math.min(nextEntryAt, now + FRESH_ENTRY_MS);
  const moving = members.some((member) => member.phase !== "on");
  // Rotation: the one most past its stay makes room for someone waiting.
  if (waiting.length && !moving && members.length >= room) {
    const due = members
      .filter(
        (member) =>
          !held.has(member.id) && now - member.since >= Math.max(member.stay, CAST_TIMING.minOnMs),
      )
      .sort((a, b) => now - b.since - b.stay - (now - a.since - a.stay))[0];
    if (due)
      members = members.map((member) =>
        member === due ? { ...member, phase: "leaving" as const, since: now } : member,
      );
  }
  const entering = members.some((member) => member.phase === "entering");
  if (waiting.length && !entering && members.length < room && now >= nextEntryAt) {
    const next = fresh[0] ?? leastRecentlyShown(waiting, state.lastShown, rank, random);
    members = [
      ...members,
      { id: next, phase: "entering", since: now, stay: between(...CAST_TIMING.stayMs, random) },
    ];
    nextEntryAt = now + between(...CAST_TIMING.gapMs, random);
  }
  // Seen until they stop: a waiting Agent stays newly busy until it has had its turn, and one that
  // went idle is forgotten, so it is newly busy again when it returns.
  const shown = new Set(members.map((member) => member.id));
  const seen = new Set(busy.filter((id) => state.seen.has(id) || shown.has(id)));
  return { ...state, members, seen, nextEntryAt };
}

function leastRecentlyShown(
  waiting: readonly string[],
  lastShown: ReadonlyMap<string, number>,
  rank: ReadonlyMap<string, number>,
  random: Random,
): string {
  let best = waiting[0]!;
  let bestScore = Infinity;
  for (const id of waiting) {
    const score =
      (lastShown.get(id) ?? -1e12) + (rank.get(id) ?? 0) * RANK_WEIGHT_MS + random() * JITTER_MS;
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/** Reduced motion: the most relevant Agents stand still; nothing enters, leaves or rotates. Their
 * stay is an ordinary one, so they rotate like any other if motion is allowed again. */
function stillCast(state: CastState, input: CastInput): CastState {
  const keep = input.busy.slice(0, input.capacity);
  const previous = new Map(state.members.map((member) => [member.id, member]));
  return {
    ...state,
    members: keep.map((id) => ({
      ...(previous.get(id) ?? { id, since: input.now, stay: CAST_TIMING.stayMs[0] }),
      phase: "on" as const,
    })),
    seen: new Set(input.busy),
    started: true,
  };
}
