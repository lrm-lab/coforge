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

test("a link right after Chinese text may start the next line", () => {
  expect(
    html([
      element("p", [
        text("详见"),
        element("a", [text("https://github.com/x")], { href: "https://github.com/x" }),
        text("的改动"),
      ]),
    ]),
  ).toBe('<p>详见<wbr><a href="https://github.com/x">https://github.com/x</a>的改动</p>');
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
