import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import { CliError } from "#src/cli-error";

const transport = (calls: unknown[] = []) => ({
  check: async () => ({ messages: [] }),
  read: async () => undefined,
  send: async () => undefined,
  view: async () => ({ bytes: new Uint8Array() }),
  setChannelMuted: async (target: string, muted: boolean) => {
    calls.push([target, muted]);
    return { accepted: true };
  },
});

test("mute and unmute take the channel as a positional or as --target", () => {
  for (const args of [["#general"], ["--target", "#general"], ["#general", "--target", "#general"]])
    expect(parseArgs(["channel", "mute", ...args])).toEqual({
      command: "mute",
      target: "#general",
    });
  expect(parseArgs(["channel", "unmute", "#ops"])).toEqual({ command: "unmute", target: "#ops" });
});

test("two different channels, or a target that is not a channel, are refused with Raft's codes", () => {
  const refusal = (args: string[]) => {
    try {
      parseArgs(["channel", "mute", ...args]);
    } catch (error) {
      return error as CliError;
    }
    throw new Error("expected a refusal");
  };
  expect(refusal(["#a", "--target", "#b"]).code).toBe("INVALID_ARG");
  for (const target of ["@alice", "#general:12345678", "", "general"])
    expect(refusal(target ? [target] : []).code).toBe("INVALID_TARGET");
  expect(refusal(["#a", "#b"]).message).toContain("Usage: coforge channel mute");
});

test("mute prints what changed, what still arrives and how to undo it", async () => {
  const calls: unknown[] = [];
  expect(await run(["channel", "mute", "#general"], transport(calls))).toBe(
    [
      "Muted #general.",
      "Activity muted: yes",
      "Ordinary channel messages in this channel no longer wake you; the history stays readable.",
      "Still arrives:",
      "- Personal @mentions still reach you.",
      "- Threads you started or follow stay followed.",
      'To unmute: coforge channel unmute --target "#general"',
    ].join("\n"),
  );
  expect(await run(["channel", "unmute", "--target", "#general"], transport(calls))).toBe(
    [
      "Unmuted #general.",
      "Activity muted: no",
      "Ordinary channel messages in this channel wake you again.",
      'To mute: coforge channel mute --target "#general"',
    ].join("\n"),
  );
  expect(calls).toEqual([
    ["#general", true],
    ["#general", false],
  ]);
});
