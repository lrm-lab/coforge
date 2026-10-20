// The hard rules' identity rule (scripts/ci/hard-rules.ts): the author and committer of a commit
// must not look like an Agent or bot. It reads them for the commit being made (pre-commit) or for
// every commit in a range (CI), and reports which identity matched which pattern. No allowlist.
// See docs/agents/git-hooks/hard-rules.md.
import { git } from "../git-hooks/staged-file-size";

/** Where an Agent or bot identity was found, and which one. */
export type IdentityMatch = { location: string; found: string };

const text = (args: string[]) => git(args).toString();

// Each glob is matched against the name and the email; a model's name (`gpt-5…`, never `GPT4all`
// or `llama3`) against the name.
const AGENT_IDENTITIES = [
  "coforge-*",
  "*@anthropic.com",
  "cursoragent@cursor.com",
  "*[bot]",
  "*-agent@*",
  "*@coforge.local",
  "*@ampcode.com",
];
const MODEL_NAME = /^(?:gpt|glm|claude|gemini|qwen|deepseek|kimi|grok|llama|muse)-[0-9]/i;
const identityPatterns = AGENT_IDENTITIES.map(
  (glob) =>
    new RegExp(
      `^${glob
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
      "i",
    ),
);

/** The Agent or bot pattern `name <email>` matches, or undefined for a person's identity. */
export function authorViolation(name: string, email: string): string | undefined {
  const index = identityPatterns.findIndex(
    (pattern) => pattern.test(name.trim()) || pattern.test(email.trim()),
  );
  if (index !== -1) return AGENT_IDENTITIES[index];
  return MODEL_NAME.test(name.trim()) ? `the model name pattern ${MODEL_NAME.source}` : undefined;
}

/** `role` is "author" or "committer"; `identity` is `[name, email]`. */
function identityMatch(location: string, role: string, [name, email]: string[]): IdentityMatch[] {
  const pattern = authorViolation(name!, email!);
  if (!pattern) return [];
  return [{ location, found: `${role} ${name} <${email}> matches ${pattern}` }];
}

/** The author and committer of every commit `git log <revisions>` lists (CI's range, or `--all`'s
 * history). */
export function commitIdentities(revisions: string[]): IdentityMatch[] {
  return text(["log", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce", ...revisions, "--"])
    .split("\n")
    .filter(Boolean)
    .flatMap((row) => {
      const [sha, ...identities] = row.split("\0");
      const location = `commit ${sha!.slice(0, 12)}`;
      return [
        ...identityMatch(location, "author", identities.slice(0, 2)),
        ...identityMatch(location, "committer", identities.slice(2, 4)),
      ];
    });
}

/** The author or committer of the commit being made: `git var GIT_<role>_IDENT`. */
function stagedIdentity(role: "author" | "committer"): IdentityMatch[] {
  const variable = `GIT_${role.toUpperCase()}_IDENT`;
  const ident = /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(text(["var", variable]).trim());
  if (!ident) throw new Error(`git var ${variable} gave no identity`);
  return identityMatch("the commit being made", role, [ident[1]!, ident[2]!]);
}

/** The author and committer of the commit being made (pre-commit). */
export function stagedIdentities(): IdentityMatch[] {
  return [...stagedIdentity("author"), ...stagedIdentity("committer")];
}
