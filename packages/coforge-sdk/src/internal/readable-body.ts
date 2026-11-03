/**
 * The one reader of a stored message body: every structured token reads back as the text a person
 * writes. Every plain-text consumer (an Agent-facing body, a copy, a list preview) goes through it,
 * so the order and the wording live in one place.
 */
import { replaceChannelReferenceTokens, replaceThreadReferenceTokens } from "./channel-references";
import { replaceMentionTokens } from "./mentions";
import { replaceTaskReferenceTokens, type TaskReference } from "./task-references";

export type ReadableBodyNames = {
  /** The name a mention token reads as (without `@`); an unknown one leaves the token as written. */
  mention: (type: "user" | "agent", id: string) => string | undefined;
  /** A channel's current name, for channel and thread tokens; when absent or unknown, the name the
   * token stored. */
  channelName?: (id: string) => string | undefined;
  /** A task reference as this reader sees it. The DM case depends on who reads (the peer sees the
   * sender); without a resolver every reference reads canonically, as the sender wrote it. */
  task?: (reference: TaskReference) => string | undefined;
};

/**
 * The reference read back as text, from the sender's seat: `task #68`, `#channel:#68`,
 * `dm:@peer:#68`. A reader that is the DM's peer rewrites the last form to name the sender.
 */
export function canonicalTaskReference(reference: TaskReference): string {
  if (reference.kind === "local") return `task #${reference.number}`;
  if (reference.kind === "channel") return `#${reference.channelName}:#${reference.number}`;
  return `dm:@${reference.peerHandle}:#${reference.number}`;
}

/**
 * Reads a stored body back as text: `<@human|agent:uuid>` → `@name`, `<@task:68>` → `task #68`,
 * `<@task:c:…:channel:68>` → `#channel:#68`, `<@task:d:…:peer:68>` → `dm:@peer:#68`,
 * `<@channel:uuid:name>` → `#name`, `<@thread:uuid:uuid:name>` → `#name:<12 hex, dashed>`. A body
 * with no token is returned untouched.
 */
export function readableBody(body: string, names: ReadableBodyNames): string {
  if (!body.includes("<@")) return body;
  const mentions = replaceMentionTokens(body, (type, id) => {
    const name = names.mention(type, id);
    return name === undefined ? undefined : `@${name}`;
  });
  const tasks = replaceTaskReferenceTokens(
    mentions,
    (reference) => names.task?.(reference) ?? canonicalTaskReference(reference),
  );
  const threads = replaceThreadReferenceTokens(tasks, names.channelName);
  return replaceChannelReferenceTokens(threads, names.channelName);
}
