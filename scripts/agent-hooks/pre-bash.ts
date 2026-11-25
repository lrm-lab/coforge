// Claude Code PreToolUse hook for Bash: stops an agent typing the formatter binary directly. A
// default-config `oxfmt` run does not read this repository's settings and rewrites files nobody
// touched; the formatter runs through `mise run check` or a workspace script, which may call it
// themselves. Only the command line the agent types is judged, never what a script runs. Claude
// Code is the one runtime that runs this hook; nothing else sees a typed command.
import { type Decision, respond } from "./hook-output";

const DENY: Decision = {
  kind: "deny",
  reason: "AGENTS.md: never invoke the formatter binary (oxfmt) directly; run `mise run check` or the workspace's own format script.",
};
const WRAPPERS = new Set(["bunx", "npx", "pnpx", "exec", "env", "command", "time", "nohup"]);
const LAUNCH = new Set(["x", "run", "exec"]);
const SHELLS = new Set(["sh", "bash", "zsh", "fish"]);

/** The commands of a shell line: split at unquoted `;`, `&`, `|`, newlines, parentheses and
 * backticks, with quotes kept in each command's words. */
function commands(line: string): string[][] {
  const out: string[][] = [[]];
  let word = "";
  let quote = "";
  const endWord = () => {
    if (word) out.at(-1)!.push(word);
    word = "";
  };
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = "";
      else word += ch;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (/\s/.test(ch) && ch !== "\n") endWord();
    else if (/[;&|\n()`]/.test(ch)) {
      endWord();
      if (out.at(-1)!.length > 0) out.push([]);
    } else word += ch;
  }
  endWord();
  return out.filter((words) => words.length > 0);
}

const isFormatter = (word: string) => /(^|\/)oxfmt$/.test(word);

function runsFormatter(words: string[]): boolean {
  let i = 0;
  // Skip what only launches the real command: `FOO=1`, `env`, `bunx`, `bun x`, `bun --bun`, `mise exec --`, flags.
  for (; i < words.length; i++) {
    const word = words[i]!;
    if (/^[A-Za-z_]\w*=/.test(word) || word.startsWith("-") || WRAPPERS.has(word)) continue;
    if (word === "bun") {
      let next = i + 1;
      while (words[next]?.startsWith("-")) {
        if (words[next] === "--cwd" && words[next + 1]) next += 2;
        else next++;
      }
      if (LAUNCH.has(words[next] ?? "")) {
        i = next;
        continue;
      }
      if (isFormatter(words[next] ?? "")) {
        i = next;
        break;
      }
    }
    if (word === "mise" && LAUNCH.has(words[i + 1] ?? "")) i++;
    else break;
  }
  const head = words[i];
  if (head === undefined) return false;
  if (isFormatter(head)) return true;
  // `sh -c "oxfmt ."`
  const flag = words.indexOf("-c", i + 1);
  const script = SHELLS.has(head.replace(/^.*\//, "")) && flag !== -1 ? words[flag + 1] : undefined;
  return script !== undefined && commands(script).some(runsFormatter);
}

export function decide(command: string): Decision {
  return commands(command).some(runsFormatter) ? DENY : { kind: "allow" };
}

if (import.meta.main) {
  const input = (await Bun.stdin.json()) as { tool_input?: { command?: string } };
  const command = input.tool_input?.command;
  if (command) respond(decide(command));
}
