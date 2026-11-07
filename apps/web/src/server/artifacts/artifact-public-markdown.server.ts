import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Reading type, on its own: the page loads nothing, so no font of ours reaches it. */
const STYLE = `:root{color-scheme:light dark;--text:#101319;--muted:#4d5562;--line:#e4e6ea;--wash:#f4f5f6}
@media (prefers-color-scheme:dark){:root{--text:#eceef1;--muted:#a3a9b3;--line:#2c2f35;--wash:#1c1e22;background:#111214}}
body{margin:0 auto;max-width:42rem;padding:3.5rem 1.5rem 5rem;color:var(--text);font:400 1rem/1.7 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow-wrap:break-word}
h1{margin:0 0 1.5rem;font-size:2rem;line-height:1.25;font-weight:600}
h2{margin:2.5rem 0 .75rem;font-size:1.375rem;line-height:1.3;font-weight:600}
h3,h4,h5,h6{margin:2rem 0 .5rem;font-size:1.125rem;line-height:1.4;font-weight:600}
p,ul,ol,pre,table,blockquote{margin:0 0 1rem}
ul,ol{padding-left:1.5rem}
a{color:inherit;text-underline-offset:.15em}
blockquote{padding-left:1rem;border-left:2px solid var(--line);color:var(--muted)}
hr{margin:2rem 0;border:0;border-top:1px solid var(--line)}
code{padding:.1em .3em;border-radius:.25rem;background:var(--wash);font:.875em/1.5 ui-monospace,Menlo,Consolas,monospace}
pre{padding:1rem;border-radius:.5rem;background:var(--wash);overflow-x:auto}
pre code{padding:0;background:none}
table{display:block;border-collapse:collapse;overflow-x:auto}
th,td{padding:.5rem .75rem;border:1px solid var(--line);text-align:left}
th{font-weight:600}
img{max-width:100%}
@media (max-width:40rem){body{padding:2rem 1.25rem 3rem}h1{font-size:1.625rem}}`;

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * A public Markdown artifact as a page to read (task #646). Raw HTML in the text stays text, as
 * `react-markdown` leaves it. A text that opens with its own title keeps one heading.
 */
export function publicMarkdownPage(title: string, text: string): Uint8Array<ArrayBuffer> {
  const body = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, text));
  const heading = text.trimStart().startsWith(`# ${title}`) ? "" : `<h1>${escape(title)}</h1>`;
  return new TextEncoder().encode(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body>${heading}${body}</body></html>`,
  );
}
