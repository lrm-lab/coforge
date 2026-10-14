import { basename } from "node:path";

// One compiled fixture is copied under two names. The launcher must resolve the interpreter
// through its supplied PATH, so a version probe using the original environment fails.
if (
  basename(process.execPath)
    .toLowerCase()
    .replace(/\.exe$/, "") === "codex"
) {
  const interpreter = Bun.which("codex-fake-node", { PATH: Bun.env.PATH ?? "" });
  if (!interpreter) process.exit(47);
  const child = Bun.spawn([interpreter, ...Bun.argv.slice(2)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: Bun.env,
  });
  process.exit(await child.exited);
}

if (Bun.argv.includes("--version")) {
  console.log("codex 0.0-seam");
  process.exit(0);
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const request = JSON.parse(line) as { id?: string; method: string };
      if (request.method === "initialize") {
        await Bun.stdout.write(
          `${JSON.stringify({ id: request.id, result: { userAgent: "fixture" } })}\n`,
        );
      }
    }
    newline = buffer.indexOf("\n");
  }
}
