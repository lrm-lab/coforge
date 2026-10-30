// Shared by the statement classifiers: the effect of a statement on a table, and the readers of
// names and keyword sequences they use.
import { keyword, SqlSyntaxError, type Token, tokenize } from "./tokenize";

export type Lock =
  | "none"
  | "row-exclusive"
  | "share-update-exclusive"
  | "share"
  | "share-row-exclusive"
  | "exclusive"
  | "access-exclusive";

export type Effect = {
  /** The normalised table name; undefined for an unrecognised statement. */
  table?: string;
  /** A short description with no names or literals in it, for the annotation. */
  label: string;
  lock: Lock;
  /** The statement rewrites or scans the whole table. */
  scans: boolean;
  /** High risk when the table existed before the migration. */
  high: boolean;
  /** Why it is high risk, for the message. */
  why?: string;
  /** An unrecognised statement; `mentions` are the names it contains, to look up in the catalog. */
  unknown?: boolean;
  mentions?: string[];
};

/** `reset`: RESET lock_timeout (or RESET ALL), which puts the default, no timeout, back. */
export type LockTimeoutSetting = { local: boolean; ms?: number; reset?: boolean };

export type Classified = {
  line: number;
  effects: Effect[];
  /** Tables this statement creates, for the statements after it. */
  creates: string[];
  /** CREATE/DROP INDEX CONCURRENTLY, which must be the only statement of its file. */
  concurrently: boolean;
  lockTimeout?: LockTimeoutSetting;
};

/** Locks that make other sessions wait (or wait behind them): the ones a lock_timeout guards. */
export const BLOCKING: ReadonlySet<Lock> = new Set([
  "share",
  "share-row-exclusive",
  "exclusive",
  "access-exclusive",
]);

/** The name as the catalog spells it: unquoted lower-cased, quoted as is, `public.` dropped. */
export function normalizeName(parts: Token[]): string {
  const names = parts.map((part) => (part.kind === "ident" ? part.text : part.text.toLowerCase()));
  if (names.length > 1 && names[0] === "public") names.shift();
  return names.join(".");
}

export const isName = (token: Token | undefined): token is Token =>
  token !== undefined && (token.kind === "word" || token.kind === "ident");

/** A possibly qualified name at `from`: its normalised form and the index after it. */
export function readName(tokens: Token[], from: number): { name: string; end: number } | undefined {
  if (!isName(tokens[from])) return undefined;
  const parts = [tokens[from]!];
  let end = from + 1;
  while (tokens[end]?.text === "." && tokens[end]?.kind === "punct" && isName(tokens[end + 1])) {
    parts.push(tokens[end + 1]!);
    end += 2;
  }
  return { name: normalizeName(parts), end };
}

/** Skips the optional keyword sequences in `words` at `from` (e.g. IF EXISTS, ONLY). */
export function skip(tokens: Token[], from: number, ...words: string[][]): number {
  let at = from;
  for (let again = true; again;) {
    again = false;
    for (const sequence of words)
      if (sequence.every((word, n) => keyword(tokens[at + n]) === word)) {
        at += sequence.length;
        again = true;
      }
  }
  return at;
}

/** Comma-separated groups at parenthesis depth 0. */
export function splitTopLevel(tokens: Token[]): Token[][] {
  const groups: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.text === "(" && token.kind === "punct") depth++;
    else if (token.text === ")" && token.kind === "punct") depth--;
    if (depth === 0 && token.kind === "punct" && token.text === ",") groups.push([]);
    else groups.at(-1)!.push(token);
  }
  return groups;
}

/** The tokens of `tokens` at parenthesis depth 0, with their index. */
export function topLevel(tokens: Token[]): { token: Token; index: number }[] {
  const found: { token: Token; index: number }[] = [];
  let depth = 0;
  tokens.forEach((token, index) => {
    if (token.kind === "punct" && token.text === "(") depth++;
    else if (token.kind === "punct" && token.text === ")") depth--;
    else if (depth === 0) found.push({ token, index });
  });
  return found;
}

export const hasSequence = (tokens: Token[], ...words: string[]) => {
  const top = topLevel(tokens).map(({ token }) => keyword(token));
  return top.some((_, at) => words.every((word, n) => top[at + n] === word));
};

/** Names that cannot be told from a recognised statement's content: every identifier in the
 * statement, and in any string or dollar-quoted body (an EXECUTE'd statement lives in one), to be
 * looked up in the catalog. */
export function mentionsOf(tokens: Token[]): string[] {
  const names = new Set<string>();
  const visit = (list: Token[]) => {
    for (const token of list) {
      if (isName(token)) names.add(token.kind === "ident" ? token.text : token.text.toLowerCase());
      if (token.kind === "string") {
        try {
          visit(tokenize(token.text));
        } catch (error) {
          if (!(error instanceof SqlSyntaxError)) throw error;
        }
      }
    }
  };
  visit(tokens);
  return [...names];
}

export const unknownEffect = (tokens: Token[], label = "unrecognised statement"): Effect => ({
  label,
  lock: "access-exclusive",
  scans: true,
  high: true,
  unknown: true,
  why: "the statement is not one this check recognises, so it may rewrite or lock any table",
  mentions: mentionsOf(tokens),
});

export const low = (
  label: string,
  table: string | undefined,
  lock: Lock = "none",
  scans = false,
): Effect => ({
  label,
  table,
  lock,
  scans,
  high: false,
});

export const high = (
  label: string,
  table: string,
  why: string,
  lock: Lock = "access-exclusive",
  scans = false,
): Effect => ({ label, table, lock, scans, high: true, why });
