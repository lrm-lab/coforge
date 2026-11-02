import { useEffect, useState } from "react";

type Katex = typeof import("katex").default;

let katex: Promise<Katex> | undefined;

/**
 * KaTeX, its stylesheet and its copy handler, loaded the first time a message shows a formula: a
 * conversation without one never pays for them. `copy-tex` makes copying a rendered formula copy
 * its LaTeX source.
 */
function loadKatex(): Promise<Katex> {
  katex ??= Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
    import("katex/contrib/copy-tex"),
  ]).then(([module]) => module.default);
  return katex;
}

/**
 * The HTML KaTeX renders for a formula, or `null` when it cannot: an unknown command, a syntax
 * error. Bodies are untrusted, so `trust` stays off (no `\href`, `\includegraphics` or raw HTML),
 * and sizes and macro expansion are bounded so one message cannot stall the page.
 */
function renderFormula(module: Katex, source: string, display: boolean): string | null {
  try {
    return module.renderToString(source, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 500,
    });
  } catch {
    return null;
  }
}

/**
 * A formula in a message (task #287): KaTeX's rendering once it has loaded, and until then, or
 * when it cannot be rendered, the source as code, as on Raft. Copying a formula copies its source
 * (`copy-tex`), and KaTeX's MathML carries it for screen readers; a display formula scrolls
 * sideways when it is wider than the message.
 */
export function MessageFormula({ source, display }: { source: string; display: boolean }) {
  const [rendered, setRendered] = useState<{
    source: string;
    display: boolean;
    html: string | null;
  }>();
  useEffect(() => {
    let alive = true;
    loadKatex().then(
      (module) =>
        alive && setRendered({ source, display, html: renderFormula(module, source, display) }),
      () => alive && setRendered({ source, display, html: null }),
    );
    return () => {
      alive = false;
    };
  }, [source, display]);
  const html = rendered?.source === source && rendered.display === display ? rendered.html : null;

  if (display)
    return html ? (
      <div className="message-markdown-formula" dangerouslySetInnerHTML={{ __html: html }} />
    ) : (
      <div className="message-markdown-code">
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  return html ? (
    <span className="message-markdown-formula-inline" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <code>{source}</code>
  );
}
