import { MESSAGE_ANCHOR_SOURCE, UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";

const FULL_THREAD_TARGET = new RegExp(
  `^((?:@[^:]+)|(?:#[a-z0-9][a-z0-9_-]{0,31})):(${UUID_LIKE_SOURCE})$`,
);
const SHORT_THREAD_TARGET = new RegExp(
  `^((?:@[^:]+)|(?:#[a-z0-9][a-z0-9_-]{0,31})):(${MESSAGE_ANCHOR_SOURCE})$`,
);

/** The one-message read of a thread's parent by anchor that settles a short thread target. */
export type ThreadRootRead = (
  parent: string,
  anchor: string,
) => Promise<{
  accepted: boolean;
  messages: readonly { id: string; target?: string }[];
}>;

/** A thread target spelled with its parent message's full id: a short anchor is resolved by one
 * read of the parent, and a target that is not a thread's is returned as it is. */
export async function canonicalThreadTarget(target: string, read: ThreadRootRead): Promise<string> {
  if (FULL_THREAD_TARGET.test(target) || !target.includes(":")) return target;
  const match = SHORT_THREAD_TARGET.exec(target);
  if (!match) return target;
  const parent = match[1]!;
  const result = await read(parent, match[2]!);
  const root = result.messages[0];
  if (
    !result.accepted ||
    result.messages.length !== 1 ||
    root?.target !== parent ||
    !FULL_THREAD_TARGET.test(`${parent}:${root.id}`)
  )
    throw new Error("thread target could not be resolved to one parent message");
  return `${parent}:${root.id}`;
}
