// Claude Code PreToolUse hook for Edit/Write/MultiEdit: enforces the AGENTS.md
// rules a script can check, and injects the doc an edit needs. Inline
// suppressions are blocked at commit by the new-suppression hard rule.
import { relative } from "node:path";

type HookInput = {
  cwd?: string;
  tool_input?: { file_path?: string };
};

export type Decision =
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string }
  | { kind: "context"; text: string }
  | { kind: "allow" };

const EXEMPTION_CONFIG = /(^|\/)(\.oxlintrc\.json|tsconfig[^/]*\.json|\.prettierignore|bunfig\.toml)$/;

const DOCS: [RegExp, string][] = [
  [/\.(test|spec|integration|e2e)\.tsx?$/, "docs/agents/testing.md"],
  [/^apps\/web\/src\/.*\.(tsx|css)$/, "docs/design/ui-hard-rules.md"],
  [/^mise\.toml$|^scripts\/mise\//, "docs/agents/mise-tasks.md"],
];

export function decide(path: string): Decision {
  if (/(^|\/)package\.json$/.test(path))
    return { kind: "deny", reason: "AGENTS.md: never edit package.json by hand; use `bun add`, `bun remove`, `bun pm pkg set` or `bun pm pkg delete`." };
  if (/(^|\/)bun\.lock$/.test(path))
    return { kind: "deny", reason: "AGENTS.md: never hand-edit bun.lock; regenerate it through Bun." };
  if (EXEMPTION_CONFIG.test(path))
    return { kind: "ask", reason: "AGENTS.md: adding or broadening a lint, format, type-check or test exemption needs Frank's explicit prior approval." };
  const doc = DOCS.find(([re]) => re.test(path))?.[1];
  return doc ? { kind: "context", text: `Read ${doc} before this edit if you have not in this session.` } : { kind: "allow" };
}

if (import.meta.main) {
  const input = (await Bun.stdin.json()) as HookInput;
  const t = input.tool_input ?? {};
  if (!t.file_path) process.exit(0);
  const path = relative(input.cwd ?? process.cwd(), t.file_path);
  const d = decide(path);
  const out =
    d.kind === "deny" || d.kind === "ask"
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.kind, permissionDecisionReason: d.reason } }
      : d.kind === "context"
        ? { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: d.text } }
        : null;
  if (out) console.log(JSON.stringify(out));
}
