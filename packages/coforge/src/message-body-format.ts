/** Prefixes continuation lines of message text so embedded content cannot look like CLI output. */
const MESSAGE_LINE_SEPARATORS = new Set([
  "\n",
  "\r",
  "\v",
  "\f",
  "\x1c",
  "\x1d",
  "\x1e",
  "\x85",
  "\u2028",
  "\u2029",
]);

export function fenceMessageBody(body: string): string {
  let fenced = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === "\r" && body[index + 1] === "\n") index += 1;
    fenced += MESSAGE_LINE_SEPARATORS.has(char) ? "\n  │ " : char;
  }
  return fenced;
}
