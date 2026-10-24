import { AGENT_NAME_PATTERN } from "@lrm/coforge-sdk/internal";
import { STORED_USERNAME_SOURCE } from "#src/lib/username-grammar";

/** The kind a `@name~kind` direct target names; `null` for a bare `@name`. */
type PeerKind = "agent" | "human";

const USERNAME = new RegExp(`^${STORED_USERNAME_SOURCE}$`);

/** The bare `@username` of a target that may carry `~human`; an `~agent` target names no person. */
export function humanUsernameTarget(parentTarget: string) {
  const { name, kind } = parsePeerTarget(parentTarget);
  if (kind === "agent") throw new Error("invalid message target");
  return `@${name}`;
}

/**
 * An Agent's `@name`, `@name~agent` or `@name~human` direct target, before any `:thread` suffix.
 * Neither a username nor an Agent name may hold `~`, so the suffix never splits a real handle.
 * A name that is neither grammar is an invalid target, as a bad `@user` always was.
 */
export function parsePeerTarget(parentTarget: string): { name: string; kind: PeerKind | null } {
  if (!parentTarget.startsWith("@")) throw new Error("invalid message target");
  const [name, kind, extra] = parentTarget.slice(1).split("~");
  if (
    extra !== undefined ||
    !name ||
    (kind !== undefined && kind !== "agent" && kind !== "human") ||
    !(USERNAME.test(name) || AGENT_NAME_PATTERN.test(name))
  )
    throw new Error("invalid message target");
  return { name, kind: kind ?? null };
}
