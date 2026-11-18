import type { Element, ElementContent, Root } from "hast";

/** Han, kana, hangul and the CJK punctuation and full-width forms that sit between them. */
const CJK = /[⺀-〿぀-ヿ㄀-ㇿ㐀-䶿一-鿿가-힯豈-﫿︰-﹏＀-￯]/u;
/** Opening brackets and quotes: a line never ends on one. */
const OPENING = /[〈《「『【〔〖〘〚〝（［｛｟“‘]/u;
const ASCII_NO_BREAK_BEFORE = /["%'\-/=|]/;
/** Their text is code or verbatim: never broken. */
const VERBATIM = new Set(["code", "pre", "kbd", "samp"]);

function breaksBetween(before: string, after: string) {
  return CJK.test(before) && !OPENING.test(before) && ASCII_NO_BREAK_BEFORE.test(after);
}

const WBR = (): Element => ({ type: "element", tagName: "wbr", properties: {}, children: [] });

/** The first or last character an inline node shows, through nested inline elements. */
function edge(node: ElementContent | undefined, end: "first" | "last"): string {
  if (!node) return "";
  if (node.type === "text") return end === "first" ? node.value.slice(0, 1) : node.value.slice(-1);
  if (node.type !== "element" || node.tagName === "br") return "";
  return edge(end === "first" ? node.children[0] : node.children.at(-1), end);
}

/**
 * Lets a line break where Chinese (or Japanese, Korean) text runs into a path or other ASCII run
 * that starts with a character browsers keep on the line before it: `路径：/Users/…`. They find no
 * break between the two, so the whole stretch is one word, and wrapping broke it between the last
 * two Chinese characters instead ("路" / "径：/Users…").
 * A `<wbr>` there keeps `路径：` on its line and starts the path on the next. Code is left alone.
 */
export function rehypeCjkBreaks() {
  return (tree: Root) => visit(tree);
}

function visit(parent: Root | Element) {
  const children: Root["children"] = [];
  for (const child of parent.children) {
    const previous = children.at(-1);
    if (
      previous &&
      child.type !== "doctype" &&
      previous.type !== "doctype" &&
      breaksBetween(
        edge(previous as ElementContent, "last"),
        edge(child as ElementContent, "first"),
      )
    )
      children.push(WBR());
    if (child.type === "text") {
      let start = 0;
      for (let index = 1; index < child.value.length; index += 1) {
        if (!breaksBetween(child.value[index - 1]!, child.value[index]!)) continue;
        children.push({ type: "text", value: child.value.slice(start, index) }, WBR());
        start = index;
      }
      children.push(start === 0 ? child : { type: "text", value: child.value.slice(start) });
      continue;
    }
    if (child.type === "element" && !VERBATIM.has(child.tagName)) visit(child);
    children.push(child);
  }
  parent.children = children as never;
}
