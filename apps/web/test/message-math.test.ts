import { describe, expect, test } from "bun:test";
import type { Nodes } from "mdast";

import { readMessageReferences } from "#src/lib/message-references";
import { messageSource, parseMessageSyntax } from "#src/lib/message-syntax";

/**
 * Formulas in a message body (task #287): which text reads as a formula, in text or on its own,
 * and what stays prose. The renderer and the send-time reference recognizer read this one grammar.
 */

/** A body's tree, written compactly: `T(…)` text, `F(…)` a formula in text, `D(…)` a display one. */
function read(body: string): string {
  const show = (node: Nodes): string => {
    if (node.type === "text") return `T(${node.value})`;
    if (node.type === "inlineMath") return `F(${node.value})`;
    if (node.type === "math") return `D(${node.value})`;
    if (node.type === "code") return `code(${node.lang ?? ""}:${node.value})`;
    if (node.type === "inlineCode") return `inlineCode(${node.value})`;
    return "children" in node ? node.children.map(show).join(" ") : node.type;
  };
  return show(parseMessageSyntax(messageSource(body)));
}

describe("single-dollar formulas follow Pandoc's rules, so prices stay text", () => {
  test("a formula opens on a non-space and closes after one", () => {
    expect(read("$x^2$ and $y$")).toBe("F(x^2) T( and ) F(y)");
    expect(read("$ x$")).toBe("T($ x$)");
    expect(read("$x $")).toBe("T($x $)");
  });

  test("amounts of money are not formulas", () => {
    expect(read("costs $5 to $10")).toBe("T(costs $5 to $10)");
    expect(read("price $5")).toBe("T(price $5)");
    expect(read("a $x$5")).toBe("T(a $x$5)");
  });

  test("a formula does not cross a line, and `\\$` is a dollar inside it", () => {
    expect(read("line $a\nb$")).toBe("T(line $a\nb$)");
    expect(read("$a\\$b$")).toBe("F(a\\$b)");
  });
});

describe("double dollars and LaTeX delimiters", () => {
  test("`$$…$$` in a line is a formula in text; alone in its paragraph, a display formula", () => {
    expect(read("text $$a$$ more")).toBe("T(text ) F(a) T( more)");
    expect(read("$$a+b$$")).toBe("D(a+b)");
    expect(read("$$\na+b\n$$")).toBe("D(a+b)");
  });

  test("`\\(…\\)` is a formula in text and `\\[…\\]` a display formula", () => {
    expect(read("\\(a\\) ok")).toBe("F(a) T( ok)");
    expect(read("\\[x\\]")).toBe("D(x)");
    expect(read("\\[\nx\n\\]")).toBe("D(x)");
    // An escaped backslash before the parenthesis is a backslash and a parenthesis.
    expect(read("\\\\(a\\\\)")).toBe("T(\\(a\\))");
  });

  test("the LaTeX delimiters keep every offset of the body", () => {
    const body = "see \\(a\\) and \\[b\\]";
    expect(messageSource(body)).toHaveLength(body.length);
  });

  test("a ```math fence is a code block the renderer draws as a formula", () => {
    expect(read("```math\nx^2\n```")).toBe("code(math:x^2)");
  });
});

describe("a formula is never prose", () => {
  test("`<` inside a formula is the author's, outside code it is still escaped", () => {
    expect(read("$a<b$ and \\(c<d\\)")).toBe("F(a<b) T( and ) F(c<d)");
    expect(read("$$\na<b\n$$")).toBe("D(a<b)");
  });

  test("code keeps its dollars and delimiters as written", () => {
    expect(read("`$x$` and `\\(y\\)`")).toBe("inlineCode($x$) T( and ) inlineCode(\\(y\\))");
  });

  test("a handle inside a formula is not a mention, one outside it still is", () => {
    const { candidates } = readMessageReferences("@ada wrote $@bob + 1$ and \\(@cy\\)");
    expect(candidates.handles).toEqual(["ada"]);
  });
});
