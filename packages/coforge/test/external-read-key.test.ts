import { expect, test } from "bun:test";
import { readFirstLine, readHiddenLine } from "../src/external/read-key";

function terminal() {
  let listener: ((chunk: Buffer | string) => void) | undefined;
  const raw: boolean[] = [];
  const shown: string[] = [];
  const input = {
    isTTY: true,
    setRawMode: (mode: boolean) => void raw.push(mode),
    resume: () => {},
    pause: () => {},
    on: (_event: "data", next: (chunk: Buffer | string) => void) => void (listener = next),
    off: () => void (listener = undefined),
  };
  return {
    input,
    raw,
    shown,
    type: (text: string) => listener?.(text),
    listening: () => listener !== undefined,
    prompt: (text: string) => void shown.push(text),
  };
}

test("the hidden prompt returns what was typed, never echoes it and restores the terminal", async () => {
  const t = terminal();
  const line = readHiddenLine(t.input, t.prompt);
  t.type("sk_ext_ab");
  t.type("x\u007fcd\r");
  expect(await line).toBe("sk_ext_abcd");
  expect(t.shown.join("")).toBe("Agent key: \n");
  expect(t.raw).toEqual([true, false]);
  expect(t.listening()).toBe(false);
});

test("Ctrl-C cancels the hidden prompt", async () => {
  const t = terminal();
  const line = readHiddenLine(t.input, t.prompt);
  t.type("sk_\u0003");
  await expect(line).rejects.toMatchObject({ code: "LOGIN_CANCELLED" });
  expect(t.raw).toEqual([true, false]);
});

test("without a terminal the first line of stdin is the key", async () => {
  async function* chunks(...parts: string[]) {
    for (const part of parts) yield new TextEncoder().encode(part);
  }
  expect(await readFirstLine(chunks("sk_ext_a", "bc\r\nignored\n"))).toBe("sk_ext_abc");
  expect(await readFirstLine(chunks("sk_ext_only"))).toBe("sk_ext_only");
  expect(await readFirstLine(chunks())).toBe("");
});
