import { describe, expect, test } from "bun:test";

import { DIRECT_MESSAGE_MAX_LENGTH } from "#src/features/conversations/conversation.schemas";
import { briefingFirstMessage, buildBriefing } from "./handoff-briefing";

const roles = { user: "User", assistant: "Assistant" };
const render = ({ firstMessage, recent }: { firstMessage: string; recent: string }) =>
  `Opening:\n${firstMessage}\n\nRecent:\n${recent}\n\nCarry on.`;

describe("truncation", () => {
  const turn = (text: string) => ({ role: "user" as const, text, timestampMs: 1 });
  const echo = ({ firstMessage }: { firstMessage: string; recent: string }) => firstMessage;

  test("cuts a long opening request to the limit with an ellipsis", () => {
    const text = buildBriefing({
      firstMessage: `  ${"a".repeat(3000)}  `,
      turns: [],
      roles,
      render: echo,
    });
    expect(text).toBe(`${"a".repeat(1999)}…`);
  });
  test("keeps a request within the limit whole, trimmed", () => {
    expect(buildBriefing({ firstMessage: "  abc  ", turns: [], roles, render: echo })).toBe("abc");
  });
  test("does not split a surrogate pair", () => {
    const text = buildBriefing({ firstMessage: "😀".repeat(2500), turns: [], roles, render: echo });
    expect(text).toBe(`${"😀".repeat(1999)}…`);
  });
  test("cuts a long turn to the turn limit", () => {
    const text = buildBriefing({
      firstMessage: "x",
      turns: [turn("b".repeat(900))],
      roles,
      render: ({ recent }) => recent,
    });
    expect(text).toBe(`User: ${"b".repeat(799)}…`);
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
    expect(text.length).toBeLessThanOrEqual(DIRECT_MESSAGE_MAX_LENGTH);
    expect(text.endsWith("/Users/frank/Code/app/Users/frank/Code/app")).toBe(true);
  });

  test("shrinks the quotes further when the template itself is long", () => {
    const text = buildBriefing({
      firstMessage: "q".repeat(8192),
      turns: [turn("user", "u".repeat(8192))],
      roles,
      render: ({ firstMessage, recent }) => `${"t".repeat(6000)}\n${firstMessage}\n${recent}`,
    });
    expect(text.length).toBeLessThanOrEqual(DIRECT_MESSAGE_MAX_LENGTH);
  });
});
