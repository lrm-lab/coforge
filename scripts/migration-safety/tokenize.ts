// A SQL tokenizer for migration files: comments are dropped, quoted text becomes one token whatever
// it contains, and statements are split on the semicolons that are outside quotes and parentheses.
// It knows PostgreSQL's lexical forms: nested /* */ comments, '' and "" doubling, E'..' backslash
// strings, and $$..$$ / $tag$..$tag$ dollar quoting. It does not parse; classify.ts reads the tokens.

export type TokenKind = "word" | "ident" | "string" | "number" | "punct";
export type Token = {
  kind: TokenKind;
  /** A word as written, a quoted identifier or string without its quotes, or the punctuation. */
  text: string;
  line: number;
};
export type Statement = { tokens: Token[]; line: number };

export class SqlSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`);
  }
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const length = sql.length;
  let i = 0;
  let line = 1;
  const advance = (to: number) => {
    for (; i < to; i++) if (sql[i] === "\n") line++;
  };

  /** Reads a quoted run starting at the quote at `i`; `quote` doubled is the quote itself. */
  const quoted = (quote: string, backslash: boolean): string => {
    const startLine = line;
    let text = "";
    let j = i + 1;
    for (; j < length; j++) {
      const c = sql[j]!;
      if (backslash && c === "\\") {
        text += sql.slice(j, j + 2);
        j++;
      } else if (c === quote) {
        if (sql[j + 1] !== quote) {
          advance(j + 1);
          return text;
        }
        text += quote;
        j++;
      } else text += c;
    }
    throw new SqlSyntaxError(
      `unterminated ${quote === "'" ? "string" : "quoted identifier"}`,
      startLine,
    );
  };

  while (i < length) {
    const c = sql[i]!;
    const startLine = line;
    if (/\s/.test(c)) {
      advance(i + 1);
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      advance(end < 0 ? length : end);
    } else if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < length && depth > 0) {
        if (sql.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else j++;
      }
      if (depth > 0) throw new SqlSyntaxError("unterminated /* comment", startLine);
      advance(j);
    } else if (c === "'") {
      tokens.push({ kind: "string", text: quoted("'", false), line: startLine });
    } else if (c === '"') {
      tokens.push({ kind: "ident", text: quoted('"', false), line: startLine });
    } else if (c === "$" && DOLLAR_TAG.test(sql.slice(i, i + 258))) {
      const delimiter = DOLLAR_TAG.exec(sql.slice(i, i + 258))![0];
      const close = sql.indexOf(delimiter, i + delimiter.length);
      if (close < 0) throw new SqlSyntaxError(`unterminated ${delimiter} quoting`, startLine);
      const body = sql.slice(i + delimiter.length, close);
      advance(close + delimiter.length);
      tokens.push({ kind: "string", text: body, line: startLine });
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < length && WORD_PART.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      advance(j);
      if (sql[i] === "'" && /^[ebxn]$/i.test(word)) {
        tokens.push({ kind: "string", text: quoted("'", /^e$/i.test(word)), line: startLine });
      } else if (/^u$/i.test(word) && sql.startsWith("&'", i)) {
        advance(i + 1);
        tokens.push({ kind: "string", text: quoted("'", false), line: startLine });
      } else tokens.push({ kind: "word", text: word, line: startLine });
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < length && /[0-9A-Za-z_.]/.test(sql[j]!)) j++;
      tokens.push({ kind: "number", text: sql.slice(i, j), line: startLine });
      advance(j);
    } else {
      const text = sql.startsWith("::", i) ? "::" : c;
      tokens.push({ kind: "punct", text, line: startLine });
      advance(i + text.length);
    }
  }
  return tokens;
}

/** The statements of `sql`, split on top-level semicolons; empty statements are dropped. */
export function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokenize(sql)) {
    if (token.kind === "punct") {
      if (token.text === "(") depth++;
      else if (token.text === ")") depth = Math.max(0, depth - 1);
      else if (token.text === ";" && depth === 0) {
        if (current.length > 0) statements.push({ tokens: current, line: current[0]!.line });
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  if (current.length > 0) statements.push({ tokens: current, line: current[0]!.line });
  return statements;
}

/** The upper-cased text of an unquoted word token, else undefined. */
export const keyword = (token: Token | undefined): string | undefined =>
  token?.kind === "word" ? token.text.toUpperCase() : undefined;
