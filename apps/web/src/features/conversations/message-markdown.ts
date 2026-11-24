import {
  CHANNEL_REFERENCE_TOKEN_PATTERN,
  CHANNEL_TASK_REFERENCE_PATTERN,
  DM_TASK_REFERENCE_PATTERN,
  MENTION_PATTERN,
  MENTION_TOKEN_PATTERN,
  TASK_REFERENCE_TOKEN_PATTERN,
  THREAD_REFERENCE_TOKEN_PATTERN,
  canonicalTaskReference,
  readTaskReferenceToken,
  threadReferenceText,
} from "@lrm/coforge-sdk/internal";
import type { Element, Root, Text } from "hast";

import type { Mentionable, MentionRef } from "./mention-text";
import {
  channelChip,
  directTaskReferenceByPeer,
  mentionChip,
  taskReference,
  threadChip,
  type ChipMention,
} from "./message-reference-chips";

export function mentionHandlesByToken(mentions: readonly MentionRef[]): Map<string, ChipMention> {
  return new Map(
    mentions.map((mention) => [
      `${mention.kind}:${mention.actorId.toLowerCase()}`,
      {
        actorId: mention.actorId,
        handle: mention.handle,
        label: mention.label,
        agentId: mention.kind === "agent" ? mention.actorId : undefined,
      },
    ]),
  );
}

export function plainMentionsByHandle(
  members: readonly Pick<Mentionable, "kind" | "id" | "handle" | "label">[] | undefined,
): Map<string, ChipMention> | undefined {
  if (!members?.length) return undefined;
  return new Map(
    members.map((member) => [
      member.handle,
      {
        actorId: member.id,
        handle: member.handle,
        label: member.label,
        agentId: member.kind === "agent" ? member.id : undefined,
      },
    ]),
  );
}

type Place = "prose" | "link";

type ReferenceChipOptions = {
  mentions: Map<string, ChipMention>;
  viewerId?: string;
  plainMentions?: Map<string, ChipMention>;
  channelNames?: ReadonlyMap<string, string>;
};

const BASE_REFERENCE_PATTERNS = [
  MENTION_TOKEN_PATTERN,
  TASK_REFERENCE_TOKEN_PATTERN,
  DM_TASK_REFERENCE_PATTERN,
  CHANNEL_TASK_REFERENCE_PATTERN,
  CHANNEL_REFERENCE_TOKEN_PATTERN,
  THREAD_REFERENCE_TOKEN_PATTERN,
] as const;

export function patternAlternation(patterns: readonly RegExp[]): {
  pattern: RegExp;
  read: (match: RegExpMatchArray) => { index: number; groups: string[] };
} {
  const flags = [...new Set(["g", ...patterns.flatMap((each) => [...each.flags])])]
    .filter((flag) => flag !== "y")
    .join("");
  const groupCounts = patterns.map(
    (each) => new RegExp(`${each.source}|`, flags).exec("")!.length - 1,
  );
  const pattern = new RegExp(patterns.map((each) => `(${each.source})`).join("|"), flags);
  return {
    pattern,
    read: (match) => {
      let group = 1;
      let index = 0;
      while (match[group] === undefined) group += 1 + groupCounts[index++]!;
      return { index, groups: match.slice(group + 1, group + 1 + groupCounts[index]!) as string[] };
    },
  };
}

const BASE_REFERENCE_ALTERNATION = patternAlternation(BASE_REFERENCE_PATTERNS);
const PLAIN_REFERENCE_ALTERNATION = patternAlternation([
  ...BASE_REFERENCE_PATTERNS,
  MENTION_PATTERN,
]);

const EMPTY_CHANNEL_IDS: ReadonlyMap<string, string> = new Map();
const channelIdByNameCache = new WeakMap<
  ReadonlyMap<string, string>,
  ReadonlyMap<string, string>
>();

export function cachedChannelIdByName(
  channelNames: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> {
  if (!channelNames || channelNames.size === 0) return EMPTY_CHANNEL_IDS;
  const cached = channelIdByNameCache.get(channelNames);
  if (cached) return cached;
  const map = new Map<string, string>();
  for (const [id, name] of channelNames) map.set(name.toLowerCase(), id);
  channelIdByNameCache.set(channelNames, map);
  return map;
}

function buildReferenceMatch(
  kindIndex: number,
  groups: readonly string[],
  place: Place,
  options: ReferenceChipOptions,
  channelIdByName: ReadonlyMap<string, string>,
): Element | Text | undefined {
  const { mentions, viewerId, plainMentions, channelNames } = options;
  switch (kindIndex) {
    case 0: {
      const [kind, id] = groups;
      const mention = mentions.get(
        `${kind!.toLowerCase() === "human" ? "user" : "agent"}:${id!.toLowerCase()}`,
      );
      if (!mention) return undefined;
      return place === "link"
        ? { type: "text", value: `@${mention.label}` }
        : mentionChip(mention, viewerId);
    }
    case 1: {
      const reference = readTaskReferenceToken(["", ...groups]);
      if (!reference) return undefined;
      return place === "prose"
        ? taskReference(reference)
        : { type: "text", value: canonicalTaskReference(reference) };
    }
    case 2: {
      const [peer, number] = groups;
      return place === "prose" ? directTaskReferenceByPeer(peer!, Number(number)) : undefined;
    }
    case 3: {
      const [name, number] = groups;
      const id = channelIdByName.get(name!.toLowerCase());
      if (id === undefined || place !== "prose") return undefined;
      return taskReference(
        {
          kind: "channel",
          conversationId: id,
          channelName: name!.toLowerCase(),
          number: Number(number),
        },
        { prose: true },
      );
    }
    case 4: {
      const [rawId, stored] = groups;
      const id = rawId!.toLowerCase();
      const current = channelNames?.get(id);
      return place === "prose" && current !== undefined
        ? channelChip(id, current)
        : { type: "text", value: `#${current ?? stored!}` };
    }
    case 5: {
      const [rawChannelId, rawRootId, stored] = groups;
      const channelId = rawChannelId!.toLowerCase();
      const rootId = rawRootId!.toLowerCase();
      const current = channelNames?.get(channelId);
      return place === "prose" && current !== undefined
        ? threadChip(channelId, rootId, current)
        : { type: "text", value: threadReferenceText(current ?? stored!, rootId) };
    }
    case 6: {
      const [handle] = groups;
      const mention = plainMentions?.get(handle!);
      return mention && place === "prose" ? mentionChip(mention, viewerId) : undefined;
    }
    default:
      return undefined;
  }
}

export function rehypeReferenceChips(options: ReferenceChipOptions) {
  const plain = options.plainMentions !== undefined && options.plainMentions.size > 0;
  const { pattern, read } = plain ? PLAIN_REFERENCE_ALTERNATION : BASE_REFERENCE_ALTERNATION;
  const channelIdByName = cachedChannelIdByName(options.channelNames);

  const parts = (value: string, place: Place): Array<Element | Text> | undefined => {
    const result: Array<Element | Text> = [];
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      const { index: kind, groups } = read(match);
      const built = buildReferenceMatch(kind, groups, place, options, channelIdByName);
      if (built === undefined) continue;
      if (match.index > offset)
        result.push({ type: "text", value: value.slice(offset, match.index) });
      result.push(built);
      offset = match.index + match[0].length;
    }
    if (result.length === 0) return undefined;
    if (offset < value.length) result.push({ type: "text", value: value.slice(offset) });
    return result;
  };

  return (tree: Root) => {
    const visit = (node: Root | Element, place: Place) => {
      const next: Array<Element | Text> = [];
      let changed = false;
      for (const child of node.children as Array<Element | Text>) {
        if (child.type === "element") {
          if (child.tagName !== "code" && child.tagName !== "pre")
            visit(child, child.tagName === "a" ? "link" : place);
        } else if (
          child.type === "text" &&
          (child.value.includes("<@") ||
            child.value.includes(":#") ||
            (plain && child.value.includes("@")))
        ) {
          const replaced = parts(child.value, place);
          if (replaced) {
            next.push(...replaced);
            changed = true;
            continue;
          }
        }
        next.push(child);
      }
      if (changed) node.children = next;
    };

    visit(tree, "prose");
  };
}
