import { expect, test } from "bun:test";
import { toHtml } from "hast-util-to-html";

import { rehypeCjkBreaks } from "#src/features/conversations/message-cjk-breaks";

function text(value: string) {
  return { type: "text", value };
}

function element(tagName: string, children: unknown[], properties = {}) {
  return { type: "element", tagName, properties, children };
}

function html(children: unknown[]) {
  const tree = { type: "root", children } as never;
  rehypeCjkBreaks()(tree);
  return toHtml(tree);
}

test("a path right after Chinese punctuation may start the next line", () => {
  expect(html([element("p", [text("日志路径：/Users/frank/notes.md 已更新")])])).toBe(
    "<p>日志路径：<wbr>/Users/frank/notes.md 已更新</p>",
  );
});

test("a quote or flag right after Chinese text may start the next line", () => {
  expect(html([element("p", [text('参数"--force"和-v')])])).toBe(
    '<p>参数<wbr>"--force"和<wbr>-v</p>',
  );
});

test("letters, digits and links after Chinese text already break there, so autospace can space them", () => {
  // A <wbr> between Han and Latin would stop text-autospace from adding its gap.
  expect(
    html([
      element("p", [
        text("用Claude把PR 128合进main，详见"),
        element("a", [text("https://github.com/x")], { href: "https://github.com/x" }),
      ]),
    ]),
  ).toBe(
    '<p>用Claude把PR 128合进main，详见<a href="https://github.com/x">https://github.com/x</a></p>',
  );
});

test("no break after an opening bracket, before closing punctuation, or inside code", () => {
  expect(
    html([element("p", [text("（abc）完成."), element("code", [text("中a")]), text("。")])]),
  ).toBe("<p>（abc）完成.<code>中a</code>。</p>");
});

test("Latin text and spaced mixed text are unchanged", () => {
  expect(html([element("p", [text("plain text, 中文 and words")])])).toBe(
    "<p>plain text, 中文 and words</p>",
  );
});
