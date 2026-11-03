/**
 * The chips a message body's references become (`rehypeReferenceChips`, `message-markdown.ts`):
 * fixed `span`s whose only text is a resolved label, injected after sanitizing.
 */
import { threadReferenceText } from "@lrm/coforge-sdk/internal";
import type { Element } from "hast";

/**
 * Complete class literals so Tailwind's source scan emits every utility. The chip treatment
 * matches the one the plain-text renderer used: a soft brand fill, and the stronger solid fill
 * for a mention of the viewing user (the way Slack marks "@you"). `message-markdown-mention` is
 * the stable hook the stylesheet and the component use to recognise a chip.
 */
const CHIP_BASE = "message-markdown-mention rounded-sm px-0.5 font-medium";
export const MENTION_CHIP_CLASS = `${CHIP_BASE} bg-brand-primary text-brand-secondary`;
export const MENTION_CHIP_SELF_CLASS = `${CHIP_BASE} bg-brand-solid text-white`;
/** Added by the renderer to a mention chip that opens a profile (a host passed the handler), so the
 * stylesheet gives it the pointer and hover affordance of a control; an inert chip lacks it. */
export const MENTION_CHIP_OPENABLE_CLASS = "message-markdown-mention-openable";

/**
 * Channel-reference chip classes. A `<@channel:uuid:name>` token renders with the same soft fill as
 * the other reference chips; the renderer turns the chip into a link to that channel (see
 * `message-body.tsx`).
 */
export const CHANNEL_CHIP_CLASS =
  "message-markdown-channel-reference rounded-sm px-0.5 font-medium bg-brand-primary text-brand-secondary";
/** The chip's `className` list, split once; nothing mutates it. */
const CHANNEL_CHIP_CLASSES = CHANNEL_CHIP_CLASS.split(" ");

/**
 * Thread-reference chip classes. A `<@thread:uuid:uuid:name>` token renders with the same soft fill;
 * the renderer turns the chip into a link that opens the thread in its channel (see
 * `message-body.tsx`).
 */
export const THREAD_CHIP_CLASS =
  "message-markdown-thread-reference rounded-sm px-0.5 font-medium bg-brand-primary text-brand-secondary";
const THREAD_CHIP_CLASSES = THREAD_CHIP_CLASS.split(" ");

/** A resolved mention as a chip needs the mentioned actor's id (who the viewer is compared with,
 * a handle being a name that may change hands), its handle and current display label, plus the
 * Agent id to open its profile panel when applicable. */
export type ChipMention = { actorId: string; handle: string; label: string; agentId?: string };

/** A mention chip: the self treatment for the viewer, and the id of the Agent or person whose
 * profile the renderer opens from it, and the label it shows. */
export function mentionChip(mention: ChipMention, viewerId: string | undefined): Element {
  // An Agent is never the viewer, whatever ids are compared.
  const self = Boolean(viewerId) && !mention.agentId && mention.actorId === viewerId;
  const className = (self ? MENTION_CHIP_SELF_CLASS : MENTION_CHIP_CLASS).split(" ");
  return {
    type: "element",
    tagName: "span",
    properties: {
      className,
      "data-mention-label": mention.label,
      ...(mention.agentId
        ? { "data-mention-agent-id": mention.agentId }
        : { "data-mention-user-id": mention.actorId }),
    },
    children: [{ type: "text", value: `@${mention.label}` }],
  };
}

/** A task reference, written as the words it stands for until the renderer resolves it. */
export function taskReference(number: number): Element {
  return {
    type: "element",
    tagName: "span",
    properties: { "data-task-reference-number": number },
    children: [{ type: "text", value: `task #${number}` }],
  };
}

/** A channel chip under the channel's current name. */
export function channelChip(id: string, name: string): Element {
  return {
    type: "element",
    tagName: "span",
    properties: { className: CHANNEL_CHIP_CLASSES, "data-channel-id": id },
    children: [{ type: "text", value: `#${name}` }],
  };
}

/** A thread chip, `#name:xxxxxxxx-xxxx` under the channel's current name. */
export function threadChip(channelId: string, rootId: string, name: string): Element {
  return {
    type: "element",
    tagName: "span",
    properties: {
      className: THREAD_CHIP_CLASSES,
      "data-thread-channel-id": channelId,
      "data-thread-root-id": rootId,
    },
    children: [{ type: "text", value: threadReferenceText(name, rootId) }],
  };
}
