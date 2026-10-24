import { truncateCodePoints } from "@lrm/coforge-sdk/internal";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { CHARS_PER_TOKEN, estimateTokens } from "@lrm/coforge-anvil";
import { escapeXmlText } from "@lrm/coforge-sdk/internal";
import {
  actionLine,
  hotObjects,
  readTranscriptActions,
  SENSITIVE_PATH_RE,
  type HotObject,
  type TranscriptAction,
} from "./recycle-actions";
import { collectRecentMessages, type RecentMessage } from "./recycle-messages";
import { findClaudeSessionTranscript } from "./session-transcript";

/**
 * The briefing a recycled Claude session opens with, built from the old session's transcript.
 * Ported from the reference Computer's constructed wake panel (Raft 1.0.51 `buildConstructedPanel`
 * and `formatConstructedPanel`): XML-delimited, self-labelling sections with no announcement line,
 * rendered into a token budget. Transcript shapes: see `session-transcript.ts` (UNDOCUMENTED,
 * observed with Claude Code 2.1.309 on 2026-10-23).
 */

const OBJECT_CONTENT_CAP_TOKENS = 700;
const STALE_OBJECT_BODY_CAP_TOKENS = 300;
const RECENT_ACTIONS = 12;
const REREAD_FILE_MAX_BYTES = 64 * 1024;
/** Messages kept when the caller does not say; `0` turns the section off. */
const RECENT_MESSAGES_DEFAULT = 25;
const MESSAGE_MAX_TOKENS = 2_000;
const MESSAGES_SECTION_CAP_TOKENS = 4_000;
const OBJECT_IN_PLAY_WINDOW_MS = 2 * 3_600_000;
const OBJECT_IN_PLAY_ACTIONS = 40;
const MAX_PANEL_OBJECTS = 14;
/** The fewest actions that make a session worth a panel. */
const MIN_ACTIONS = 5;
const MEMORY_FILE_RE = /(^|\/)MEMORY\.md$/;
const TRUNCATED = "\n[… truncated]";
const MESSAGE_TRUNCATED = "\n[… truncated — read the channel for the rest]";

type PanelObject = {
  name: string;
  touches: number;
  lastTs: string | null;
  transcriptBody: string | null;
  rereadBody: string | null;
};

/**
 * A file's current text, or `null`: only a regular, small, text file whose real location (every
 * symlink resolved) is inside `root` and not sensitive. The final component is opened with
 * `O_NOFOLLOW`, so a link swapped in after the check is refused too.
 */
async function rereadFile(path: string, realRoot: string | null): Promise<string | null> {
  if (realRoot === null) return null;
  try {
    const real = await realpath(path);
    if (
      !real.startsWith(realRoot + sep) ||
      SENSITIVE_PATH_RE.test(real) ||
      MEMORY_FILE_RE.test(real)
    )
      return null;
    const info = await lstat(real);
    if (!info.isFile() || info.size > REREAD_FILE_MAX_BYTES) return null;
    const handle = await open(
      real,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > REREAD_FILE_MAX_BYTES) return null;
      const text = await handle.readFile({ encoding: "utf8" });
      return text.includes("\0") ? null : text;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Where an in-play file may be re-read: inside the workspace (relative names resolve against it). */
function rereadablePath(name: string, root: string): string | undefined {
  const path = resolve(root, name);
  return path.startsWith(root + sep) ? path : undefined;
}

function messageLine(message: RecentMessage): string {
  return estimateTokens(message.raw.length) <= MESSAGE_MAX_TOKENS
    ? message.raw
    : `${truncateCodePoints(message.raw, MESSAGE_MAX_TOKENS * CHARS_PER_TOKEN)}${MESSAGE_TRUNCATED}`;
}

function clip(body: string, tokenLimit: number): string {
  let clipped = truncateCodePoints(body, tokenLimit * CHARS_PER_TOKEN);
  if (clipped.length >= body.length) return clipped;
  const lastBreak = clipped.lastIndexOf("\n");
  if (lastBreak > clipped.length / 2) clipped = clipped.slice(0, lastBreak);
  return clipped + TRUNCATED;
}

function formatPanel(input: {
  messages: readonly RecentMessage[];
  objects: readonly PanelObject[];
  tail: readonly TranscriptAction[];
  totalActions: number;
  budgetTokens: number;
}): string {
  const sections: string[] = [];
  if (input.messages.length > 0) {
    // At the default budget this is Raft's 4000-token cap; a smaller budget shrinks it.
    const cap = Math.min(MESSAGES_SECTION_CAP_TOKENS, Math.floor(input.budgetTokens / 2));
    const lines = input.messages.map(messageLine);
    while (lines.length > 1 && estimateTokens(lines.join("\n\n").length) > cap) lines.shift();
    sections.push(
      '<recent-messages order="newest last" note="recent tail only; older messages not shown">',
      clip(lines.join("\n\n"), cap),
      "</recent-messages>",
      "",
    );
  }
  const tailSection = [
    `<recent-actions span="${input.tail.length} of ${input.totalActions}" order="oldest first">`,
    ...input.tail.map(actionLine),
    "</recent-actions>",
  ];
  let left =
    input.budgetTokens -
    estimateTokens(sections.join("\n").length) -
    estimateTokens(tailSection.join("\n").length) -
    60;
  const objectLines = ["<objects-in-play>"];
  for (const object of input.objects) {
    if (left <= 80) break;
    const name = escapeXmlText(object.name);
    const observed = object.lastTs ? ` last-observed="${escapeXmlText(object.lastTs)}"` : "";
    const pointer = `<object name="${name}" touched="${object.touches}x"${observed}/>`;
    let body = object.transcriptBody;
    let freshness = object.lastTs ? `last observed ${object.lastTs}` : "last observed earlier";
    if (object.rereadBody !== null) {
      body = object.rereadBody;
      freshness = "current — re-read just now";
    } else if (body) {
      freshness += "; could not re-read, may be stale";
    }
    if (!body) {
      objectLines.push(pointer);
      left -= estimateTokens(pointer.length);
      continue;
    }
    const title = `<object name="${name}" touched="${object.touches}x" freshness="${escapeXmlText(freshness)}">`;
    // A long name can leave nothing for the body: a pointer then, never a negative cut.
    if (left - estimateTokens(title.length) - 4 <= 0) {
      objectLines.push(pointer);
      left -= estimateTokens(pointer.length);
      continue;
    }
    left -= estimateTokens(title.length) + 4;
    const cap =
      object.rereadBody !== null ? OBJECT_CONTENT_CAP_TOKENS : STALE_OBJECT_BODY_CAP_TOKENS;
    const clipped = clip(body, Math.min(cap, left));
    objectLines.push(title, clipped, "</object>");
    left -= estimateTokens(clipped.length);
  }
  objectLines.push("</objects-in-play>");
  return [...sections, ...objectLines, "", ...tailSection].join("\n");
}

/** The panel for the transcript at `transcriptPath`, or `undefined` when the session did too little. */
export async function buildConstructedPanel(options: {
  transcriptPath: string;
  workingDirectory: string;
  budgetTokens: number;
  recentMessagesMax?: number;
}): Promise<string | undefined> {
  const actions = await readTranscriptActions(options.transcriptPath);
  if (actions.length < MIN_ACTIONS) return;
  const recentMax = options.recentMessagesMax ?? RECENT_MESSAGES_DEFAULT;
  const messages =
    recentMax > 0 ? await collectRecentMessages(options.transcriptPath, recentMax) : [];
  const maxIndex = Math.max(1, ...actions.map((action) => action.i));
  const lastTsMs = [...actions]
    .reverse()
    .map((action) => (action.ts ? Date.parse(action.ts) : Number.NaN))
    .find(Number.isFinite);
  const isInPlay = (object: HotObject) => {
    if (lastTsMs !== undefined && object.lastTs) {
      const objectMs = Date.parse(object.lastTs);
      if (Number.isFinite(objectMs)) return lastTsMs - objectMs <= OBJECT_IN_PLAY_WINDOW_MS;
    }
    return object.last >= maxIndex - OBJECT_IN_PLAY_ACTIONS;
  };
  const weight = (object: HotObject) => object.touches * (0.3 + object.last / maxIndex);
  // In-play objects first, then the most touched and most recent. Only the first few are shown, so
  // only those are re-read.
  const ranked = hotObjects(actions)
    .map((object) => ({ object, inPlay: isInPlay(object), weight: weight(object) }))
    .sort((a, b) => Number(b.inPlay) - Number(a.inPlay) || b.weight - a.weight)
    .slice(0, MAX_PANEL_OBJECTS);
  const root = resolve(options.workingDirectory);
  const realRoot = await realpath(root).catch(() => null);
  const objects: PanelObject[] = await Promise.all(
    ranked.map(async ({ object, inPlay }) => {
      // A MEMORY.md body belongs to the memory block, not to this panel.
      const allowed =
        inPlay && !MEMORY_FILE_RE.test(object.name) && !SENSITIVE_PATH_RE.test(object.name);
      const path = allowed ? rereadablePath(object.name, root) : undefined;
      return {
        name: object.name,
        touches: object.touches,
        lastTs: object.lastTs,
        transcriptBody: allowed ? object.content : null,
        rereadBody: path ? await rereadFile(path, realRoot) : null,
      };
    }),
  );
  return formatPanel({
    messages,
    objects,
    tail: actions.slice(-RECENT_ACTIONS),
    totalActions: actions.length,
    budgetTokens: options.budgetTokens,
  });
}

/** `CodeAgentProvider.readRecycleBriefing` for Claude Code; any failure means no briefing. */
export async function readClaudeRecycleBriefing(options: {
  sessionId: string;
  workingDirectory: string;
  budgetTokens: number;
  envVars?: Readonly<Record<string, string>>;
}): Promise<string | undefined> {
  if (!(options.budgetTokens > 0)) return;
  try {
    const transcriptPath = await findClaudeSessionTranscript(options.sessionId, options.envVars);
    if (!transcriptPath) return;
    return await buildConstructedPanel({ ...options, transcriptPath });
  } catch {
    return;
  }
}
