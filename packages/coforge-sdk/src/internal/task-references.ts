/**
 * Structured task references — the stored-body form of a task reference, in the same spirit as the
 * embedded mention token (`<@human:uuid>` / `<@agent:uuid>`, see `mentions.ts`).
 *
 * Three shapes, all read back as the reference a person writes:
 * - this conversation's task: `<@task:68>` → `task #68`;
 * - another channel's task: `<@task:c:<conversation uuid>:<channel name>:<68>>` → `#channel:#68`;
 * - a direct message's task: `<@task:d:<conversation uuid>:<peer handle>:<68>>` → `dm:@peer:#68`.
 *
 * The conversation id is the stable anchor; the name and the peer handle are what the sender saw,
 * so a reader who cannot resolve the conversation still reads a canonical reference. The DM token
 * names the peer as the sender wrote it; a reader who is the peer sees the sender instead (the
 * server resolves that view, this module only carries the parts).
 */
import { UUID_LIKE_SOURCE } from "./uuid";

const UUID = UUID_LIKE_SOURCE;
const CHANNEL = "[a-z0-9][a-z0-9_-]*";
/** Raft's peer handle: word characters, dots and dashes, with an optional `~agent`/`~human`. */
const PEER = "[\\w.-]+(?:~(?:agent|human))?";

/** The prose form `task #68`: case-insensitive, whole-word `task` and the number not a prefix. */
export const TASK_REFERENCE_PATTERN = /(?<![A-Za-z0-9_])task #(\d+)(?![0-9])/gi;

/** The prose form bare `#68`: not after a word character or `/`, no leading zero, word boundary. */
export const BARE_TASK_REFERENCE_PATTERN = /(?<![\w/])#([1-9]\d*)\b/g;

/**
 * Raft's cross-conversation task references: `#channel:#68` and `dm:@peer:#68`. The separator is
 * `:#`; the reference ends before a word character, `/`, `-`, or another `:#` — the same boundary
 * Raft's `RAFT_TASK_REF_END_PATTERN` sets, so `#design:#68x` and `#design:#68:#9` stay prose.
 */
export const CHANNEL_TASK_REFERENCE_PATTERN = new RegExp(
  `#(${CHANNEL}):#([1-9]\\d*)(?![\\w/-]|:#)`,
  "gu",
);

/** A direct message's task, `dm:@peer:#68`; the peer may carry Raft's `~agent`/`~human`. */
export const DM_TASK_REFERENCE_PATTERN = new RegExp(
  `dm:@(${PEER}):#([1-9]\\d*)(?![\\w.~/-]|:#)`,
  "giu",
);

/** One resolved task reference: this conversation's, another channel's, or a direct message's. */
export type TaskReference =
  | { kind: "local"; number: number }
  | { kind: "channel"; conversationId: string; channelName: string; number: number }
  | { kind: "dm"; conversationId: string; peerHandle: string; number: number };

/** Every stored-body task token, whatever its shape. Groups: number, or `c:`/`d:` and its parts. */
export const TASK_REFERENCE_TOKEN_PATTERN = new RegExp(
  `<@task:(?:(\\d+)|c:(${UUID}):(${CHANNEL}):(\\d+)|d:(${UUID}):(${PEER}):(\\d+))>`,
  "gi",
);

/** The stored-body token for one task of this conversation. */
export function taskReferenceToken(number: number): string {
  return `<@task:${number}>`;
}

/** The stored-body token for one task of another channel. */
export function channelTaskReferenceToken(
  conversationId: string,
  channelName: string,
  number: number,
): string {
  return `<@task:c:${conversationId.toLowerCase()}:${channelName}:${number}>`;
}

/** The stored-body token for one task of a direct message, named as the sender sees the peer. */
export function dmTaskReferenceToken(
  conversationId: string,
  peerHandle: string,
  number: number,
): string {
  return `<@task:d:${conversationId.toLowerCase()}:${peerHandle}:${number}>`;
}

/** The reference a token carries, or undefined when the token is malformed. */
export function readTaskReferenceToken(match: RegExpExecArray): TaskReference | undefined {
  if (match[1] !== undefined) return { kind: "local", number: Number(match[1]) };
  if (match[2] !== undefined)
    return {
      kind: "channel",
      conversationId: match[2].toLowerCase(),
      channelName: match[3]!,
      number: Number(match[4]),
    };
  if (match[5] !== undefined)
    return {
      kind: "dm",
      conversationId: match[5].toLowerCase(),
      peerHandle: match[6]!,
      number: Number(match[7]),
    };
  return undefined;
}

/**
 * Rewrites every task-reference token through `resolve`, leaving a token `resolve` does not know
 * byte-for-byte intact — the same contract as `replaceMentionTokens`, so a caller that lacks the
 * task rows degrades to the raw token rather than dropping the reference.
 */
export function replaceTaskReferenceTokens(
  body: string,
  resolve: (reference: TaskReference) => string | undefined,
): string {
  return body.replace(TASK_REFERENCE_TOKEN_PATTERN, (token, ...groups) => {
    const match = [token, ...groups] as unknown as RegExpExecArray;
    const reference = readTaskReferenceToken(match);
    return reference ? (resolve(reference) ?? token) : token;
  });
}
