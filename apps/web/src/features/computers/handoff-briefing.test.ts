import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER, type LocalSessionEntry } from "@lrm/coforge-sdk/internal";

import {
  freeAgentName,
  BRIEFING_MAX_LENGTH,
  briefingFirstMessage,
  buildBriefing,
  defaultAgentName,
  defaultProvider,
  isRecentlyActive,
  lastFolder,
  preferredComputerId,
  shortenPath,
  sortSessions,
  truncateText,
} from "./handoff-briefing";

const roles = { user: "User", assistant: "Assistant" };
const render = ({ firstMessage, recent }: { firstMessage: string; recent: string }) =>
  `Opening:\n${firstMessage}\n\nRecent:\n${recent}\n\nCarry on.`;

function entry(over: Partial<LocalSessionEntry>): LocalSessionEntry {
  return {
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    sessionId: "s1",
    cwd: "/Users/frank/Code/app",
    model: "",
    title: "",
    updatedAtMs: 0,
    matchKind: "recent",
    snippet: "",
    ...over,
  };
}

describe("isRecentlyActive", () => {
  const now = 10_000_000;
  test("is active inside five minutes, idle from five minutes on", () => {
    expect(isRecentlyActive(now - 4 * 60_000, now)).toBe(true);
    expect(isRecentlyActive(now - 5 * 60_000, now)).toBe(false);
    expect(isRecentlyActive(now - 60 * 60_000, now)).toBe(false);
  });
  test("treats a timestamp ahead of the clock as active", () => {
    expect(isRecentlyActive(now + 30_000, now)).toBe(true);
  });
});

describe("defaultAgentName", () => {
  test("is the last folder in username form", () => {
    expect(defaultAgentName("/Users/frank/Code/My App/", "Codex")).toBe("my-app");
    expect(defaultAgentName("C:\\work\\Web_Site", "Codex")).toBe("web-site");
  });
  test("falls back to the tool when the folder has no username characters", () => {
    expect(defaultAgentName("/Users/frank/代码", "Claude Code")).toBe("claude-code");
    expect(defaultAgentName("/", "Codex")).toBe("codex");
  });
  test("lastFolder ignores trailing separators", () => {
    expect(lastFolder("/a/b//")).toBe("b");
    expect(lastFolder("")).toBe("");
  });
});

describe("shortenPath", () => {
  test("shows the home folder as ~", () => {
    expect(shortenPath("/Users/frank")).toBe("~");
    expect(shortenPath("/home/frank/app")).toBe("~/app");
    expect(shortenPath("C:\\Users\\frank\\app")).toBe("~/app");
  });
  test("keeps the last two folders of a long path", () => {
    expect(shortenPath("/Users/frank/Code/coforge/apps/web")).toBe("…/apps/web");
    expect(shortenPath("/var/lib/app")).toBe("/var/lib/app");
    expect(shortenPath("/srv/a/b/c")).toBe("…/b/c");
  });
  test("keeps a short path whole", () => {
    expect(shortenPath("/")).toBe("/");
    expect(shortenPath("/tmp/")).toBe("/tmp");
  });
});

describe("sessions", () => {
  test("sorts the newest first without touching the input", () => {
    const input = [
      entry({ sessionId: "a", updatedAtMs: 1 }),
      entry({ sessionId: "b", updatedAtMs: 3 }),
    ];
    expect(sortSessions(input).map((s) => s.sessionId)).toEqual(["b", "a"]);
    expect(input[0]!.sessionId).toBe("a");
  });
  test("opens on the tool of the newest session, else Claude Code", () => {
    expect(
      defaultProvider([
        entry({ updatedAtMs: 1 }),
        entry({ provider: RUNTIME_PROVIDER.CODEX, sessionId: "c", updatedAtMs: 2 }),
      ]),
    ).toBe(RUNTIME_PROVIDER.CODEX);
    expect(defaultProvider([])).toBe(RUNTIME_PROVIDER.CLAUDE_CODE);
  });
  test("prefers the only Computer, then an online one", () => {
    expect(preferredComputerId([])).toBeUndefined();
    expect(preferredComputerId([{ id: "a", online: false }])).toBe("a");
    expect(
      preferredComputerId([
        { id: "a", online: false },
        { id: "b", online: true },
      ]),
    ).toBe("b");
  });
});

describe("truncateText", () => {
  test("cuts to the limit with an ellipsis", () => {
    expect(truncateText("  abcdef  ", 4)).toBe("abc…");
    expect(truncateText("abc", 3)).toBe("abc");
    expect(truncateText("abc", 0)).toBe("");
  });
  test("does not split a surrogate pair", () => {
    expect(truncateText("ab😀cd", 4)).toBe("ab…");
  });
});

describe("briefingFirstMessage", () => {
  test("is the opening request, else the title, else a dash", () => {
    expect(briefingFirstMessage(" fix it ", "Title")).toBe("fix it");
    expect(briefingFirstMessage("", " Title ")).toBe("Title");
    expect(briefingFirstMessage(undefined, " ")).toBe("-");
  });
});

describe("buildBriefing", () => {
  const turn = (role: "user" | "assistant", text: string) => ({ role, text, timestampMs: 1 });

  test("lists the turns oldest first under their role", () => {
    const text = buildBriefing({
      firstMessage: "Add a flag",
      turns: [turn("user", "hello"), turn("assistant", "hi there")],
      roles,
      render,
    });
    expect(text).toBe(
      "Opening:\nAdd a flag\n\nRecent:\nUser: hello\n\nAssistant: hi there\n\nCarry on.",
    );
  });

  test("shows a dash when there is nothing to quote", () => {
    expect(buildBriefing({ firstMessage: "", turns: [], roles, render })).toBe(
      "Opening:\n-\n\nRecent:\n-\n\nCarry on.",
    );
  });

  test("keeps the newest turns when they do not all fit", () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn("user", `${i}`.repeat(700)));
    const text = buildBriefing({ firstMessage: "x", turns, roles, render });
    expect(text).toContain("11".repeat(1));
    expect(text).toContain(`User: ${"11".repeat(350)}`);
    expect(text).not.toContain(`User: ${"0".repeat(700)}`);
  });

  test("fits a message for the largest excerpt the daemon can send", () => {
    const turns = Array.from({ length: 12 }, (_, i) =>
      turn(i % 2 ? "assistant" : "user", "é".repeat(2000)),
    );
    const text = buildBriefing({
      firstMessage: "q".repeat(8192),
      turns,
      roles,
      render: ({ firstMessage, recent }) =>
        `${"t".repeat(700)}\n${firstMessage}\n${recent}\n${"/Users/frank/Code/app".repeat(2)}`,
    });
    expect(text.length).toBeLessThanOrEqual(BRIEFING_MAX_LENGTH);
    expect(text.endsWith("/Users/frank/Code/app/Users/frank/Code/app")).toBe(true);
  });

  test("shrinks the quotes further when the template itself is long", () => {
    const text = buildBriefing({
      firstMessage: "q".repeat(8192),
      turns: [turn("user", "u".repeat(8192))],
      roles,
      render: ({ firstMessage, recent }) => `${"t".repeat(6000)}\n${firstMessage}\n${recent}`,
    });
    expect(text.length).toBeLessThanOrEqual(BRIEFING_MAX_LENGTH);
  });
});

describe("freeAgentName", () => {
  test("keeps a name nobody has", () => {
    expect(freeAgentName("coforge", new Set(["other"]))).toBe("coforge");
  });
  test("steps past taken names, compared without case", () => {
    expect(freeAgentName("Coforge", new Set(["coforge", "coforge-2"]))).toBe("Coforge-3");
  });
});
