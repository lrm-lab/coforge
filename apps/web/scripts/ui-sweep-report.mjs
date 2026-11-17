import { writeFile } from "node:fs/promises";
import path from "node:path";

/** Writes the sweep's findings.json, findings.md and contact sheet, and prints the summary. */
export function sweepReporter({ baseUrl: BASE_URL, outDir: OUT_DIR, start: START }) {
  async function writeReports(results, notes) {
    await writeFile(
      path.join(OUT_DIR, "findings.json"),
      JSON.stringify({ baseUrl: BASE_URL, notes, results }, null, 2),
    );

    const byCheck = new Map();
    for (const r of results) {
      for (const f of r.findings) {
        if (!byCheck.has(f.check)) byCheck.set(f.check, []);
        byCheck.get(f.check).push({
          ...f,
          surface: r.surface,
          theme: r.theme,
          width: r.width,
          screenshot: r.screenshot,
        });
      }
      for (const e of r.consoleErrors) {
        if (!byCheck.has("console-error")) byCheck.set("console-error", []);
        byCheck.get("console-error").push({
          detail: e,
          surface: r.surface,
          theme: r.theme,
          width: r.width,
          screenshot: r.screenshot,
        });
      }
      for (const e of r.exceptions) {
        if (!byCheck.has("exception-thrown")) byCheck.set("exception-thrown", []);
        byCheck.get("exception-thrown").push({
          detail: e,
          surface: r.surface,
          theme: r.theme,
          width: r.width,
          screenshot: r.screenshot,
        });
      }
    }

    const lines = [];
    lines.push(`# UI sweep findings`);
    lines.push("");
    lines.push(`Base URL: ${BASE_URL}`);
    lines.push(`Surfaces captured: ${results.length}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");
    if (notes.length) {
      lines.push("## Notes");
      for (const n of notes) lines.push(`- ${n}`);
      lines.push("");
    }

    const reachNotes = results.filter((r) => r.note);
    if (reachNotes.length) {
      lines.push("## Surfaces the sweep could not fully reach");
      for (const r of reachNotes)
        lines.push(`- ${r.surface} (${r.theme}, ${r.width}px): ${r.note}`);
      lines.push("");
    }

    lines.push("## Findings by check");
    for (const [check, items] of [...byCheck.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`### ${check} (${items.length})`);
      for (const item of items.slice(0, 20)) {
        lines.push(
          `- **${item.surface}** · ${item.theme} · ${item.width}px — ${item.detail}${item.locator ? ` \`${item.locator}\`` : ""} ([${item.screenshot}](./${item.screenshot}))`,
        );
      }
      if (items.length > 20) lines.push(`- … ${items.length - 20} more`);
      lines.push("");
    }

    await writeFile(path.join(OUT_DIR, "findings.md"), lines.join("\n"));

    const html = buildContactSheet(results);
    await writeFile(path.join(OUT_DIR, "index.html"), html);
  }

  function esc(s) {
    return String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  function buildContactSheet(results) {
    const rows = results
      .map((r) => {
        const findingsHtml = r.findings
          .map(
            (f) =>
              `<li><b>${esc(f.check)}</b>: ${esc(f.detail)}${f.locator ? ` <code>${esc(f.locator)}</code>` : ""}</li>`,
          )
          .join("");
        const consoleHtml = [
          ...r.consoleErrors.map((e) => `<li class="err">console.error: ${esc(e)}</li>`),
          ...r.exceptions.map((e) => `<li class="err">exception: ${esc(e)}</li>`),
        ].join("");
        const clean =
          r.findings.length === 0 &&
          r.consoleErrors.length === 0 &&
          r.exceptions.length === 0 &&
          !r.note;
        return `<section class="card ${clean ? "clean" : "flagged"}">
    <h3>${esc(r.surface)} <span class="tag">${esc(r.theme)}</span> <span class="tag">${r.width}px</span></h3>
    ${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
    ${r.screenshot ? `<img loading="lazy" src="${esc(r.screenshot)}" alt="${esc(r.surface)}" />` : "<p>no screenshot</p>"}
    <ul class="findings">${findingsHtml}${consoleHtml}</ul>
    ${r.sidebarWidth != null ? `<p class="meta">sidebar width: ${r.sidebarWidth}px</p>` : ""}
  </section>`;
      })
      .join("\n");

    return `<!doctype html>
  <html>
  <head>
  <meta charset="utf-8" />
  <title>UI sweep — ${esc(BASE_URL)}</title>
  <style>
    body { font: 14px/1.4 -apple-system, sans-serif; background: #f7f7f8; color: #111; margin: 0; padding: 24px; }
    h1 { font-size: 18px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
    .card { background: #fff; border: 1px solid #e2e2e5; border-radius: 8px; padding: 12px; }
    .card.flagged { border-color: #e58a8a; }
    .card h3 { margin: 0 0 8px; font-size: 13px; }
    .tag { display: inline-block; font-size: 11px; color: #555; border: 1px solid #ddd; border-radius: 4px; padding: 0 4px; margin-left: 4px; }
    img { width: 100%; border: 1px solid #ddd; border-radius: 4px; }
    .findings { font-size: 12px; padding-left: 18px; margin: 8px 0 0; }
    .findings li.err { color: #a11; }
    .note { color: #a15c00; font-size: 12px; }
    .meta { font-size: 11px; color: #777; }
  </style>
  </head>
  <body>
  <h1>UI sweep — ${esc(BASE_URL)} — ${results.length} captures</h1>
  <div class="grid">
  ${rows}
  </div>
  </body>
  </html>`;
  }

  function printSummary(results) {
    const byCheck = new Map();
    for (const r of results) {
      for (const f of r.findings) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
      if (r.consoleErrors.length)
        byCheck.set("console-error", (byCheck.get("console-error") ?? 0) + r.consoleErrors.length);
      if (r.exceptions.length)
        byCheck.set(
          "exception-thrown",
          (byCheck.get("exception-thrown") ?? 0) + r.exceptions.length,
        );
    }
    const elapsed = ((Date.now() - START) / 1000).toFixed(1);
    console.log("");
    console.log(
      `Sweep finished in ${elapsed}s — ${results.length} surface/theme/viewport captures.`,
    );
    console.log("");
    console.log("Check                          Count");
    console.log("------------------------------  -----");
    for (const [check, count] of [...byCheck.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`${check.padEnd(30)}  ${String(count).padStart(5)}`);
    }
    if (byCheck.size === 0) console.log("(no findings)");
    console.log("");
    console.log(`Output: ${OUT_DIR}`);
    console.log(`  - ${path.join(OUT_DIR, "findings.json")}`);
    console.log(`  - ${path.join(OUT_DIR, "findings.md")}`);
    console.log(`  - ${path.join(OUT_DIR, "index.html")}`);
  }

  return { writeReports, printSummary };
}
