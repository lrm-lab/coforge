import { splitCodeSpans } from "@lrm/coforge-sdk/internal";
import type { Paragraph, PhrasingContentMap, Root, RootContent, RootContentMap } from "mdast";
import remarkMath from "remark-math";
import type {
  Code,
  Construct,
  Extension,
  State,
  TokenizeContext,
  Tokenizer,
} from "micromark-util-types";
import type { Processor } from "unified";

/**
 * Formulas in a message body (task #287), as Raft writes them plus the delimiters GPT-style Agents
 * use:
 *
 * - `$$` on lines of its own fences a display formula, and so does ```math (a code fence the
 *   renderer draws as a formula);
 * - `$$…$$` in a line is a formula in the text, and a paragraph holding nothing else is a display
 *   formula;
 * - `$…$` is a formula in the text under Pandoc's rules, so prices stay text: the opening `$` is
 *   followed by a non-space, the closing `$` follows a non-space and is not followed by a digit,
 *   and the formula does not cross a line (`$5 to $10` is text);
 * - `\(…\)` reads as `$$…$$` and `\[…\]` as a display formula.
 *
 * All of it is grammar, part of the one Markdown dialect the renderer and the send-time reference
 * recognizer share (`message-syntax.ts`), so a mention token inside a formula is never a mention.
 */

/** The nodes `mdast-util-math` builds; its module augments `mdast` with them. */
type Math = RootContentMap["math"];
type InlineMath = PhrasingContentMap["inlineMath"];

declare module "micromark-util-types" {
  interface TokenTypeMap {
    mathText: "mathText";
    mathTextData: "mathTextData";
    mathTextSequence: "mathTextSequence";
  }
}

const DOLLAR = 36;
const BACKSLASH = 92;

/** micromark's codes for the end of input, a line ending, a tab and a space. */
const isSpaceOrBreak = (code: Code) =>
  code === null || code < 0 || code === 32 || (code > 0 && /\s/u.test(String.fromCodePoint(code)));
const isDigit = (code: Code) => code !== null && code >= 48 && code <= 57;

/**
 * The `$` that closes a single-dollar formula: one not followed by a digit (`$5 to $10`).
 * Checked as a lookahead, so a `$` that does not close stays part of the formula.
 */
const closingDollar: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    return (code) => {
      effects.enter("mathTextSequence");
      effects.consume(code);
      effects.exit("mathTextSequence");
      return (next: Code) => (isDigit(next) || next === DOLLAR ? nok(next) : ok(next));
    };
  },
};

/**
 * A single-dollar formula in text, tried before `remark-math`'s own (which then only reads
 * `$$…$$`). It emits `remark-math`'s tokens, so `mdast-util-math` builds the same `inlineMath`.
 */
const tokenizeSingleDollar: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  /** The last character inside the formula: a closing `$` must not follow a space. */
  let last: Code = null;

  const start: State = (code) => {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    effects.consume(code);
    effects.exit("mathTextSequence");
    return afterOpen;
  };

  // `$$` is the other construct's; a `$` before a space opens nothing.
  const afterOpen: State = (code) => {
    if (code === DOLLAR || isSpaceOrBreak(code)) return nok(code);
    effects.enter("mathTextData");
    return inside(code);
  };

  const inside: State = (code) => {
    if (code === null || (code < 0 && code !== -2 && code !== -1)) return nok(code);
    if (code === DOLLAR && !isSpaceOrBreak(last)) {
      effects.exit("mathTextData");
      return effects.check(closingDollar, close, notClosing)(code);
    }
    effects.consume(code);
    last = code;
    // `\$` is a dollar sign inside the formula, not its end.
    return code === BACKSLASH ? escaped : inside;
  };

  const escaped: State = (code) => {
    if (code === null || (code < 0 && code !== -2 && code !== -1)) return nok(code);
    effects.consume(code);
    last = code;
    return inside;
  };

  const close: State = (code) => {
    effects.enter("mathTextSequence");
    effects.consume(code);
    effects.exit("mathTextSequence");
    effects.exit("mathText");
    return ok;
  };

  const notClosing: State = (code) => {
    effects.enter("mathTextData");
    effects.consume(code);
    last = code;
    return inside;
  };

  return start;
};

const singleDollarMath: Extension = {
  text: {
    [DOLLAR]: {
      name: "mathText",
      // Tried before `remark-math`'s construct for `$`.
      add: "before",
      tokenize: tokenizeSingleDollar,
      // Not right after another `$` (that is a `$$` run), unless the `$` was escaped.
      previous(this: TokenizeContext, code) {
        return code !== DOLLAR || this.events.at(-1)?.[1].type === "characterEscape";
      },
    },
  },
};

/**
 * `escapeLiteralHtml` turned each `<` outside code into `&lt;` before parsing, as it cannot tell a
 * formula from prose; inside a formula that `<` is the author's, so it is put back.
 */
const restoreLessThan = (value: string) => value.replaceAll("&lt;", "<");

/** Whether an `inlineMath` came from `$$…$$` (or `\(…\)`, `\[…\]`): its source is at least four
 * characters longer than its value. A single-dollar formula never has padding to strip. */
const isDoubleDollar = (node: InlineMath) => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start !== undefined && end !== undefined && end - start - node.value.length >= 4;
};

/** A paragraph that holds only a `$$…$$` formula is a display formula, as on Raft. */
function displayFormula(paragraph: Paragraph): Math | undefined {
  const [only, ...rest] = paragraph.children;
  if (rest.length > 0 || only?.type !== "inlineMath" || !isDoubleDollar(only)) return undefined;
  return {
    type: "math",
    value: only.value,
    position: paragraph.position,
    data: {
      hName: "pre",
      hChildren: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-display"] },
          children: [{ type: "text", value: only.value }],
        },
      ],
    },
  };
}

/** Puts `<` back inside formulas and turns a lone `$$…$$` paragraph into a display formula. */
function settleFormulas(tree: Root) {
  const visit = (parent: { children: RootContent[] }) => {
    parent.children = parent.children.map((child) => {
      if (child.type === "paragraph") {
        const display = displayFormula(child);
        if (display) return settleFormula(display);
      }
      if (child.type === "math" || child.type === "inlineMath") return settleFormula(child);
      if ("children" in child) visit(child as { children: RootContent[] });
      return child;
    });
  };
  visit(tree);
}

function settleFormula<T extends Math | InlineMath>(node: T): T {
  const value = restoreLessThan(node.value);
  if (value === node.value) return node;
  // `mdast-util-math` also copies the value into what it hands the HTML step: the text itself
  // for a formula in text, a `code` element holding it for a display one.
  // Typed here: not every package that compiles this file loads `mdast-util-to-hast`'s `data`.
  const data = node.data as { hChildren?: { type: string }[] } | undefined;
  const text = { type: "text", value };
  const hChildren = data?.hChildren?.map((child) =>
    child.type === "element" ? { ...child, children: [text] } : text,
  );
  return { ...node, value, data: { ...data, ...(hChildren ? { hChildren } : {}) } as T["data"] };
}

/**
 * The formula grammar as a remark plugin: `remark-math` for `$$` (fenced and in text), the
 * single-dollar construct before it, and the settling pass. The pass runs as part of parsing
 * (a `mdast-util-from-markdown` transform), so `parseMessageSyntax`, which only parses, sees the
 * same tree the renderer does.
 */
export function remarkMessageMath(this: Processor) {
  // `remark-math`'s own single-dollar rule has no Pandoc guards: only its `$$` is used.
  remarkMath.call(this, { singleDollarTextMath: false });
  const data = this.data() as {
    micromarkExtensions?: Extension[];
    fromMarkdownExtensions?: { transforms?: ((tree: Root) => void)[] }[];
  };
  (data.micromarkExtensions ??= []).push(singleDollarMath);
  (data.fromMarkdownExtensions ??= []).push({ transforms: [settleFormulas] });
}

/** `\(` or `\[` not itself escaped (`\\(` is a backslash and a parenthesis). */
const LATEX_DELIMITERS = /(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)|(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g;

/**
 * `\(…\)` and `\[…\]` outside code, written as `$$…$$`: two characters for two, so every offset in
 * the body stays where it was (the reference recognizer maps offsets back to the body). `\[` on a
 * line of its own then opens a `$$` fence; one in a line is a formula in the text, and a display
 * formula when its paragraph holds nothing else.
 */
export function rewriteLatexDelimiters(body: string): string {
  if (!body.includes("\\(") && !body.includes("\\[")) return body;
  return splitCodeSpans(body)
    .map((segment) =>
      segment.code
        ? segment.text
        : segment.text.replace(
            LATEX_DELIMITERS,
            (_whole, inline: string | undefined, display: string | undefined) =>
              `$$${inline ?? display}$$`,
          ),
    )
    .join("");
}
