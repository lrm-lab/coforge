import { describe, expect, test } from "bun:test";
import {
  REPLY_INTENT_SCANNER_MAX_ARGUMENTS_CHARS,
  REPLY_INTENT_SCANNER_MAX_CALLS,
  ReplyIntentScanner,
} from "#src/code-agent/reply-intent-scanner";

const BACKSLASH = "\\";
const send = (target: string) => `coforge message send --target ${target} --content hi`;
const args = (command: string) => JSON.stringify({ command });

/** The index just past the fragment that made the scanner emit, or undefined if it never did. */
function emittedAfter(
  scanner: ReplyIntentScanner,
  fragments: readonly string[],
  call = { callId: "call-1" },
) {
  for (let index = 0; index < fragments.length; index++) {
    const event = scanner.feed({ ...call, fragment: fragments[index]! });
    if (event) return { index: index + 1, event };
  }
  return undefined;
}

const chars = (text: string) => [...text];
const chunks = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );

describe("ReplyIntentScanner", () => {
  test("announces the target once its token is closed, wherever the deltas split", () => {
    const json = args(send("#general"));
    const closedAt = json.indexOf("#general") + "#general ".length;
    for (const size of [1, 2, 3, 7, 1000]) {
      const result = emittedAfter(new ReplyIntentScanner(), chunks(json, size));
      expect(result?.event).toEqual({ type: "reply-intent", id: "call-1", target: "#general" });
      // Never before the boundary after the target, in the first delta that holds it.
      const fed = chunks(json, size).slice(0, result!.index).join("").length;
      expect(fed).toBeGreaterThanOrEqual(closedAt);
      expect(fed).toBeLessThan(closedAt + size);
    }
  });

  test("reads a quoted target once the closing quote is followed by a boundary", () => {
    const json = args(send(`"#general:ab12cd34"`));
    expect(emittedAfter(new ReplyIntentScanner(), chars(json))?.event.target).toBe(
      "#general:ab12cd34",
    );
    const single = args(`coforge message send --target '@bob' --content hi`);
    expect(emittedAfter(new ReplyIntentScanner(), chars(single))?.event.target).toBe("@bob");
  });

  test("never announces a target that is still being written", () => {
    for (const partial of [
      `{"command":"coforge message send --target @bo`,
      String.raw`{"command":"coforge message send --target \"#gen`,
      String.raw`{"command":"coforge message send --target \"#gen\"`,
      `{"command":"coforge message send --target=#gen`,
      `{"command":"coforge message send --target '#gen'`,
      `{"command":"coforge message send --target`,
      `{"command":"coforge message send --target `,
    ])
      expect(emittedAfter(new ReplyIntentScanner(), chars(partial))).toBeUndefined();

    // The rest arrives: the whole target is announced, never its truncated prefix.
    const scanner = new ReplyIntentScanner();
    const call = { callId: "call-1" };
    expect(
      scanner.feed({ ...call, fragment: `{"command":"coforge message send --target @bo` }),
    ).toBe(undefined);
    expect(scanner.feed({ ...call, fragment: `b --content hi"}` })?.target).toBe("@bob");
  });

  test("decodes JSON escapes, including a \\u escape split across deltas", () => {
    // Spelled out piece by piece: "\\u0023" is "#", and a pair of escapes is one emoji.
    const u = BACKSLASH + "u";
    const raw = `{"command":"coforge message send --target ${u}0023general --content hi"}`;
    const splitInside = raw.indexOf(u) + 4;
    expect(
      emittedAfter(new ReplyIntentScanner(), [raw.slice(0, splitInside), raw.slice(splitInside)])
        ?.event.target,
    ).toBe("#general");

    // A newline escape is a token boundary; an escaped quote belongs to the quoted target.
    const newline = `{"command":"coforge message send --target #general${BACKSLASH}nhi"}`;
    expect(emittedAfter(new ReplyIntentScanner(), chars(newline))?.event.target).toBe("#general");
    const quote = BACKSLASH + '"';
    const quoted = `{"command":"coforge message send --target ${quote}#general${quote} --x"}`;
    expect(emittedAfter(new ReplyIntentScanner(), chars(quoted))?.event.target).toBe("#general");
    // An escaped surrogate pair survives being split between its halves.
    const emoji = `{"command":"coforge message send --target #${u}d83d${u}de00 --x"}`;
    const cut = emoji.lastIndexOf(u);
    expect(
      emittedAfter(new ReplyIntentScanner(), [emoji.slice(0, cut), emoji.slice(cut)])?.event.target,
    ).toBe("#\u{1F600}");
  });

  test("announces when the command string completes, before the arguments object does", () => {
    const json = args("coforge message send --target #general");
    const fragments = chars(json);
    const result = emittedAfter(new ReplyIntentScanner(), fragments);
    expect(result?.event.target).toBe("#general");
    // The closing quote of the command is the second to last character; the brace is not needed.
    expect(result!.index).toBe(fragments.length - 1);
  });

  test("finds the command among other fields and ignores nested ones", () => {
    const before = `{"description":"say hi","timeout":5,"command":${JSON.stringify(send("#a"))}}`;
    expect(emittedAfter(new ReplyIntentScanner(), chars(before))?.event.target).toBe("#a");
    const nested = `{"meta":{"command":${JSON.stringify(send("#nested"))}},"command":"ls -la "}`;
    expect(emittedAfter(new ReplyIntentScanner(), chars(nested))).toBeUndefined();
    const notString = `{"command":["coforge","message","send","--target","#a"," "]}`;
    expect(emittedAfter(new ReplyIntentScanner(), chars(notString))).toBeUndefined();
  });

  test("announces only the Agent's own message send", () => {
    for (const command of [
      "ls -la ",
      "coforge message check --target #a ",
      "coforge message send --help ",
      "coforge message send --content hi ",
      "echo coforge message send --target #a ",
    ])
      expect(emittedAfter(new ReplyIntentScanner(), chars(args(command)))).toBeUndefined();
    expect(
      emittedAfter(new ReplyIntentScanner(), chars(args(`cd /work && ${send("@bob")}`)))?.event
        .target,
    ).toBe("@bob");
  });

  test("announces a call once, however much more it streams", () => {
    const scanner = new ReplyIntentScanner();
    const json = args(send("#general"));
    const first = emittedAfter(scanner, chars(json));
    expect(first).toBeDefined();
    const call = { callId: "call-1" };
    expect(scanner.feed({ ...call, fragment: " more" })).toBeUndefined();
    expect(emittedAfter(scanner, chars(json))).toBeUndefined();
    // Another call is its own.
    expect(emittedAfter(scanner, chars(args(send("#other"))), { callId: "call-2" })?.event).toEqual(
      { type: "reply-intent", id: "call-2", target: "#other" },
    );
  });

  test("a call that completes without an early announcement announces nothing itself", () => {
    // The target is the last token and the command string never closes in what streamed: the
    // tracker's start for the finished call is the one that announces it, not the scanner.
    const scanner = new ReplyIntentScanner();
    const call = { callId: "call-1" };
    expect(
      scanner.feed({ ...call, fragment: `{"command":"coforge message send --target #general` }),
    ).toBeUndefined();
    expect(scanner.complete("call-1")).toBeUndefined();
    expect(scanner.complete("never-fed")).toBeUndefined();
    // The released call starts over if the same id streams again.
    expect(scanner.feed({ ...call, fragment: args(send("#general")) })?.target).toBe("#general");
  });

  test("reset forgets every call in flight and names the announced ones that never completed", () => {
    const scanner = new ReplyIntentScanner();
    const call = { callId: "call-1" };
    scanner.feed({ ...call, fragment: `{"command":"coforge message send --target ` });
    emittedAfter(scanner, chars(args(send("#a"))), { callId: "announced" });
    emittedAfter(scanner, chars(args(send("#b"))), { callId: "completed" });
    scanner.complete("completed");
    expect(scanner.reset()).toEqual(["announced"]);
    expect(scanner.reset()).toEqual([]);
    expect(scanner.feed({ ...call, fragment: `#general --content hi"}` })).toBeUndefined();
  });

  test("gives up on a call whose arguments pass the argument cap", () => {
    const padding = "x".repeat(REPLY_INTENT_SCANNER_MAX_ARGUMENTS_CHARS);
    const late = JSON.stringify({ description: padding, command: send("#general") });
    expect(emittedAfter(new ReplyIntentScanner(), chunks(late, 500))).toBeUndefined();
    const within = JSON.stringify({
      description: padding.slice(0, 1000),
      command: send("#general"),
    });
    expect(emittedAfter(new ReplyIntentScanner(), chunks(within, 500))?.event.target).toBe(
      "#general",
    );
  });

  test("reads nothing until the command mentions coforge, and parses only at a token boundary", () => {
    const scanner = new ReplyIntentScanner();
    const call = { callId: "call-1" };
    // A long command that never mentions coforge is never parsed: nothing is announced from it
    // and a later mention in the same command still is.
    expect(scanner.feed({ ...call, fragment: `{"command":"echo ${"a ".repeat(50)}` })).toBe(
      undefined,
    );
    expect(
      scanner.feed({ ...call, fragment: `&& coforge message send --target @bob ` })?.target,
    ).toBe("@bob");
    // A newline or heredoc ends what is read, so a command without coforge before it is given up on.
    const settled = new ReplyIntentScanner();
    expect(settled.feed({ ...call, fragment: `{"command":"echo hi${BACKSLASH}n` })).toBeUndefined();
    expect(
      settled.feed({
        ...call,
        fragment: `coforge message send --target @bob --content hi"}`,
      }),
    ).toBeUndefined();
  });

  test("tracks a bounded number of calls and forgets the oldest", () => {
    const scanner = new ReplyIntentScanner();
    const head = `{"command":"coforge message send --target `;
    const calls = Array.from({ length: REPLY_INTENT_SCANNER_MAX_CALLS + 1 }, (_, i) => `call-${i}`);
    for (const callId of calls) scanner.feed({ callId, fragment: head });
    const finish = (callId: string) =>
      scanner.feed({ callId, fragment: `#general --content hi"}` });
    // The first call was evicted by the last one: what it had streamed is gone.
    expect(finish(calls.at(-1)!)?.target).toBe("#general");
    expect(finish(calls[1]!)?.target).toBe("#general");
    expect(finish(calls[0]!)).toBeUndefined();
  });

  test("garbage in the arguments never throws or announces", () => {
    const scanner = new ReplyIntentScanner();
    for (const fragment of ["", "}}}{{", `"command":`, `{"command":"\\q\\u12`, "\u0000"])
      expect(() => scanner.feed({ callId: "c", fragment })).not.toThrow();
    expect(scanner.feed({ callId: "c", fragment: `zz" ` })).toBeUndefined();
  });
});
