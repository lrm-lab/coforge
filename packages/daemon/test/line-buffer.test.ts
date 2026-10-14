import { expect, test } from "bun:test";

import { LineBuffer } from "#src/code-agent/line-buffer";

function feed(chunks: readonly string[]): { lines: string[]; rest: string } {
  const buffer = new LineBuffer();
  const lines: string[] = [];
  for (const chunk of chunks) buffer.push(chunk, (line) => lines.push(line));
  return { lines, rest: buffer.rest() };
}

test("a chunk with several newlines yields each line in order", () => {
  expect(feed(['{"a":1}\n{"b":2}\n{"c":3}\n'])).toEqual({
    lines: ['{"a":1}', '{"b":2}', '{"c":3}'],
    rest: "",
  });
});

test("a line split across many chunks is yielded once, whole", () => {
  const record = JSON.stringify({ content: "y".repeat(10_000) });
  const chunks: string[] = [];
  for (let i = 0; i < record.length; i += 7) chunks.push(record.slice(i, i + 7));
  chunks.push("\n");
  expect(feed(chunks)).toEqual({ lines: [record], rest: "" });
});

test("a trailing carriage return is removed, even when the newline arrives in the next chunk", () => {
  expect(feed(["one\r\ntw", "o\r", "\nthree"])).toEqual({
    lines: ["one", "two"],
    rest: "three",
  });
});

test("only one trailing carriage return is removed and inner ones are kept", () => {
  expect(feed(["a\rb\r\r\n"]).lines).toEqual(["a\rb\r"]);
});

test("empty lines are yielded so the caller decides whether to skip them", () => {
  expect(feed(["\n\r\nx\n"]).lines).toEqual(["", "", "x"]);
});

test("rest is the unterminated text after the last newline, untrimmed", () => {
  expect(feed(["done\n  partial", " tail\r"])).toEqual({
    lines: ["done"],
    rest: "  partial tail\r",
  });
});
