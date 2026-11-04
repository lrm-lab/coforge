export * from "./mentions";
export * from "./task-references";
export * from "./channel-references";
export * from "./readable-body";

/** See [message reference recognition](../../docs/agents/message-references.md). */
import {
  CHANNEL_NAME_PATTERN,
  CHANNEL_REFERENCE_PATTERN,
  THREAD_REFERENCE_PATTERN,
  channelReferenceToken,
  threadReferenceToken,
} from "./channel-references";
import { MENTION_PATTERN, mentionToken } from "./mentions";
import {
  BARE_TASK_REFERENCE_PATTERN,
  CHANNEL_TASK_REFERENCE_PATTERN,
  DM_TASK_REFERENCE_PATTERN,
  TASK_REFERENCE_PATTERN,
  channelTaskReferenceToken,
  dmTaskReferenceToken,
  taskReferenceToken,
} from "./task-references";
import { alignNode, bodyOffsets, proseTextNodes } from "./message-reference-alignment";
import { messageSource, parseMessageSyntax } from "./message-syntax";

type Reference =
  | { kind: "mention"; handle: string }
  /** `name` is the channel name, `anchor` the message id or prefix, both lower-cased. */
  | { kind: "thread"; name: string; anchor: string }
  | { kind: "task"; number: number }
  /** Another channel's task, written `#channel:#N`; `name` is lower-cased. */
  | { kind: "channelTask"; name: string; number: number }
  /** A direct message's task, written `dm:@peer:#N`; `peer` keeps its `~agent`/`~human` suffix. */
  | { kind: "dmTask"; peer: string; number: number }
  /** A bare `#N`: `name` is the whole `#name` run it starts, lower-cased, and `rest` what that run
   * holds after the number, as written (empty when the run is just the number). */
  | { kind: "bareNumber"; number: number; name: string; rest: string }
  | { kind: "channel"; name: string };

/**
 * One alternative's reading of its match: the reference, and the text it consumes. `exactPart` is
 * what a prefix of that text still reads as when the whole is not written exactly but the prefix
 * is (see `proseReferences`).
 */
type Reading = { reference: Reference; text: string; exactPart?: Omit<Reading, "exactPart"> };

/** The `#name` run a channel reference reads, anchored where a bare `#N` starts. */
const CHANNEL_RUN = new RegExp(CHANNEL_REFERENCE_PATTERN.source, "uy");

/** The alternatives in precedence order. Each reads its own match into a `Reading`. */
const ALTERNATIVES: readonly { pattern: RegExp; read: (match: RegExpExecArray) => Reading }[] = [
  {
    pattern: MENTION_PATTERN,
    read: (match) => ({ reference: { kind: "mention", handle: match[1]! }, text: match[0] }),
  },
  {
    pattern: THREAD_REFERENCE_PATTERN,
    // Channel names are stored lower-case and message ids are lower-case hex.
    read: (match) => ({
      reference: {
        kind: "thread",
        name: match[1]!.toLowerCase(),
        anchor: match[2]!.toLowerCase(),
      },
      text: match[0],
    }),
  },
  {
    pattern: TASK_REFERENCE_PATTERN,
    read: (match) => ({ reference: { kind: "task", number: Number(match[1]) }, text: match[0] }),
  },
  {
    pattern: DM_TASK_REFERENCE_PATTERN,
    read: (match) => ({
      reference: { kind: "dmTask", peer: match[1]!, number: Number(match[2]) },
      text: match[0],
    }),
  },
  {
    pattern: CHANNEL_TASK_REFERENCE_PATTERN,
    read: (match) => ({
      reference: { kind: "channelTask", name: match[1]!.toLowerCase(), number: Number(match[2]) },
      text: match[0],
    }),
  },
  { pattern: BARE_TASK_REFERENCE_PATTERN, read: readBareNumber },
  {
    pattern: CHANNEL_REFERENCE_PATTERN,
    // Channel names are stored lower-case, so a reference matches regardless of case.
    read: (match) => ({
      reference: { kind: "channel", name: match[1]!.toLowerCase() },
      text: match[0],
    }),
  },
];

/** A bare `#N`, read with the whole `#name` run it starts, so it can fall through to a channel. */
function readBareNumber(match: RegExpExecArray): Reading {
  CHANNEL_RUN.lastIndex = match.index;
  // The run always matches here: a bare `#N` is itself a `#name` run.
  const run = CHANNEL_RUN.exec(match.input)![0];
  const number = Number(match[1]);
  return {
    reference: {
      kind: "bareNumber",
      number,
      name: run.slice(1).toLowerCase(),
      rest: run.slice(match[0].length),
    },
    text: run,
    // Only the channel reading needs the whole run: the number alone is still the task.
    exactPart:
      run.length > match[0].length
        ? { reference: { kind: "task", number }, text: match[0] }
        : undefined,
  };
}

/**
 * One private scanner per alternative, created once. `exec` with `lastIndex` is stateful, so the
 * SDK's shared pattern constants are never scanned with directly; `matchesIn` sets `lastIndex`
 * before every `exec`.
 */
const SCANNERS = ALTERNATIVES.map(({ pattern }) => new RegExp(pattern.source, pattern.flags));

/** What a body's prose could refer to, deduped in first-seen order. */
type MessageReferenceCandidates = {
  /** Every `@handle`, for resolving against the conversation's mention targets. */
  handles: string[];
  /** Every `task #N` and bare `#N` number, for checking against the conversation's tasks. */
  taskNumbers: number[];
  /** Every `#name` that could be a channel's name (`CHANNEL_NAME_PATTERN`), lower-cased, for
   * checking against the Workspace's channels. */
  channelNames: string[];
  /** Every `#name:shortid` whose name a channel could be called, both lower-cased, for finding the
   * message among that channel's top-level messages. */
  threads: { name: string; anchor: string }[];
  /** Every `#channel:#N` reference, for checking that the sender may read that task. */
  channelTasks: { name: string; number: number }[];
  /** Every `dm:@peer:#N` reference, for checking that the sender is in that direct message. */
  dmTasks: { peer: string; number: number }[];
};

/** How a caller answers the candidates. An absent lookup resolves nothing of its kind. */
export type MessageReferenceLookup = {
  mention?: (handle: string) => { type: "user" | "agent"; id: string } | undefined;
  /** The task's id when `number` names one the sender may read. */
  task?: (number: number) => string | undefined;
  channel?: (name: string) => { id: string; name: string } | undefined;
  /** Another channel's task, when the sender may read that task; the token names it as written. */
  channelTask?: (
    name: string,
    number: number,
  ) => { conversationId: string; channelName: string; taskId?: string } | undefined;
  /** A direct message's task, when the sender is in that direct message. */
  dmTask?: (
    peer: string,
    number: number,
  ) => { conversationId: string; peerHandle: string; taskId?: string } | undefined;
  /** The one top-level message of the channel called `name` that `anchor` (a 6–12 hex prefix of its
   * id, or the whole id) names; `undefined` when there is none, or more than one. */
  thread?: (
    name: string,
    anchor: string,
  ) => { channelId: string; rootId: string; name: string } | undefined;
};

/** A body's references, read once: what they could mean, and the rewrite once they are answered. */
export type MessageReferences = {
  candidates: MessageReferenceCandidates;
  /**
   * The body with every reference `lookup` resolves rewritten into its stored token —
   * `<@human|agent:uuid>`, `<@task:N>`, `<@channel:uuid:name>`, `<@thread:uuid:uuid:name>` — and
   * every other byte as written. `adopted` is each rewritten reference, with its offsets in the
   * original body and the target it resolved to (task #465: a row records `raw` as written and
   * `targetId`, never a reconstructed form).
   */
  resolve: (lookup: MessageReferenceLookup) => {
    body: string;
    adopted: {
      start: number;
      end: number;
      kind: "mention" | "task" | "channel" | "thread";
      targetId: string;
    }[];
  };
};

/** Reads a body's prose references once, for the caller to look up and then resolve. */
export function readMessageReferences(body: string): MessageReferences {
  const references = proseReferences(body);
  const handles = new Set<string>();
  const taskNumbers = new Set<number>();
  const channelNames = new Set<string>();
  const threads = new Map<string, { name: string; anchor: string }>();
  const channelTasks = new Map<string, { name: string; number: number }>();
  const dmTasks = new Map<string, { peer: string; number: number }>();
  for (const { reference } of references) {
    if (reference.kind === "mention") handles.add(reference.handle);
    else if (reference.kind === "task") taskNumbers.add(reference.number);
    else if (reference.kind === "bareNumber") {
      taskNumbers.add(reference.number);
      if (CHANNEL_NAME_PATTERN.test(reference.name)) channelNames.add(reference.name);
    } else if (reference.kind === "channelTask")
      channelTasks.set(`${reference.name}:${reference.number}`, {
        name: reference.name,
        number: reference.number,
      });
    else if (reference.kind === "dmTask")
      dmTasks.set(`${reference.peer}:${reference.number}`, {
        peer: reference.peer,
        number: reference.number,
      });
    else if (reference.kind === "channel" && CHANNEL_NAME_PATTERN.test(reference.name))
      channelNames.add(reference.name);
    else if (reference.kind === "thread" && CHANNEL_NAME_PATTERN.test(reference.name))
      threads.set(`${reference.name}:${reference.anchor}`, {
        name: reference.name,
        anchor: reference.anchor,
      });
  }
  return {
    candidates: {
      handles: [...handles],
      taskNumbers: [...taskNumbers],
      channelNames: [...channelNames],
      threads: [...threads.values()],
      channelTasks: [...channelTasks.values()],
      dmTasks: [...dmTasks.values()],
    },
    resolve: (lookup) => {
      const adopted: {
        start: number;
        end: number;
        kind: "mention" | "task" | "channel" | "thread";
        targetId: string;
      }[] = [];
      let result = "";
      let cursor = 0;
      for (const { reference, start, end } of references) {
        const resolved = tokenFor(reference, lookup);
        if (resolved === undefined) continue;
        result += body.slice(cursor, start) + resolved.token;
        adopted.push({ start, end, kind: resolved.kind, targetId: resolved.targetId });
        cursor = end;
      }
      return { body: result + body.slice(cursor), adopted };
    },
  };
}

function tokenFor(
  reference: Reference,
  lookup: MessageReferenceLookup,
):
  | { token: string; kind: "mention" | "task" | "channel" | "thread"; targetId: string }
  | undefined {
  switch (reference.kind) {
    case "mention": {
      const target = lookup.mention?.(reference.handle);
      return (
        target && {
          token: mentionToken(target.type, target.id),
          kind: "mention",
          targetId: target.id,
        }
      );
    }
    case "thread": {
      const thread = lookup.thread?.(reference.name, reference.anchor);
      return (
        thread && {
          token: threadReferenceToken(thread.channelId, thread.rootId, thread.name),
          kind: "thread",
          targetId: thread.rootId,
        }
      );
    }
    case "task": {
      const taskId = lookup.task?.(reference.number);
      return taskId
        ? { token: taskReferenceToken(reference.number), kind: "task", targetId: taskId }
        : undefined;
    }
    case "channelTask": {
      const task = lookup.channelTask?.(reference.name, reference.number);
      return (
        task && {
          token: channelTaskReferenceToken(task.conversationId, task.channelName, reference.number),
          kind: "task",
          targetId: task.taskId ?? task.conversationId,
        }
      );
    }
    case "dmTask": {
      const task = lookup.dmTask?.(reference.peer, reference.number);
      return (
        task && {
          token: dmTaskReferenceToken(task.conversationId, task.peerHandle, reference.number),
          kind: "task",
          targetId: task.taskId ?? task.conversationId,
        }
      );
    }
    case "bareNumber": {
      const taskId = lookup.task?.(reference.number);
      const channel = lookup.channel?.(reference.name);
      // The task comes first, except against a channel named by a run longer than the number.
      if (channel && (reference.rest || !taskId))
        return {
          token: channelReferenceToken(channel.id, channel.name),
          kind: "channel",
          targetId: channel.id,
        };
      return taskId
        ? {
            token: taskReferenceToken(reference.number) + reference.rest,
            kind: "task",
            targetId: taskId,
          }
        : undefined;
    }
    case "channel": {
      const channel = lookup.channel?.(reference.name);
      return (
        channel && {
          token: channelReferenceToken(channel.id, channel.name),
          kind: "channel",
          targetId: channel.id,
        }
      );
    }
  }
}

/** Every reference in the body's prose, in reading order, with its offsets in `body`. */
function proseReferences(body: string): { reference: Reference; start: number; end: number }[] {
  // Every reference starts with a literal `@` or `#` (`task #N` included): without one there is
  // nothing to parse for.
  if (!body.includes("@") && !body.includes("#")) return [];
  const source = messageSource(body);
  const toBody = source === body ? undefined : bodyOffsets(body, source);
  const references: { reference: Reference; start: number; end: number }[] = [];
  // Where the last aligned text ended: a text node with no position is looked for after it.
  let cursor = 0;
  for (const { node, within } of proseTextNodes(parseMessageSyntax(source), undefined)) {
    const matches = matchesIn(node.value);
    if (matches.length === 0) {
      // Only a node that holds a match is aligned; a positioned one still moves the cursor on.
      cursor = node.position?.end.offset ?? cursor;
      continue;
    }
    const aligned = alignNode(source, node, within, cursor);
    if (!aligned) continue;
    cursor = aligned.end;
    for (const match of matches) {
      const from =
        typeof aligned.starts === "number"
          ? aligned.starts + match.index
          : aligned.starts[match.index]!;
      // Written exactly as matched: an escape or a character reference inside it means the
      // author wrote the characters literally. A reading whose exact prefix still means something
      // (a bare `#N` whose run goes on) falls back to that prefix.
      const exact = [match, match.exactPart].find(
        (reading) => reading !== undefined && source.startsWith(reading.text, from),
      );
      if (!exact) continue;
      // Reference text holds no `<`, so it maps back to the body one character for one.
      const start = toBody ? toBody(from) : from;
      references.push({ reference: exact.reference, start, end: start + exact.text.length });
    }
  }
  return references;
}

/**
 * The references in one run of prose, in reading order. Each alternative keeps its next match until
 * the cursor passes it, so a long text is scanned once per alternative.
 */
function matchesIn(text: string): (Reading & { index: number })[] {
  const upcoming: (RegExpExecArray | null | undefined)[] = SCANNERS.map(() => undefined);
  const matches: (Reading & { index: number })[] = [];
  let cursor = 0;
  for (;;) {
    let best = -1;
    for (const [index, pattern] of SCANNERS.entries()) {
      const pending = upcoming[index];
      if (pending === undefined || (pending !== null && pending.index < cursor)) {
        pattern.lastIndex = cursor;
        upcoming[index] = pattern.exec(text);
      }
      const match = upcoming[index];
      if (match && (best === -1 || match.index < upcoming[best]!.index)) best = index;
    }
    if (best === -1) return matches;
    const match = upcoming[best]!;
    const reading = ALTERNATIVES[best]!.read(match);
    matches.push({ ...reading, index: match.index });
    cursor = match.index + reading.text.length;
  }
}
