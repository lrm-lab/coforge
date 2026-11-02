import { expect, test } from "bun:test";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

/**
 * Browser E2E (task #287): formulas in a message render with KaTeX once it loads (each form:
 * `$…$`, `\(…\)`, `$$` on lines of its own, `\[…\]`, ```math), prices stay text, and a formula KaTeX
 * cannot read shows its source as code. Light and dark. Opt-in like the other browser E2Es; see
 * `helpers/agent-replying-fixture.ts`. Screenshots are written under
 * `.amp/e2e/message-formulas/`.
 */
const fx = setupAgentReplying({ artifactsName: "message-formulas" });
const { suffix, until, evaluate } = fx;

const BODY = [
  `Formulas ${suffix}: the area is $\\pi r^2$, and \\(e^{i\\pi} + 1 = 0\\). It costs $5 to $10.`,
  "$$",
  "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  "$$",
  "\\[ \\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6} \\]",
  "```math",
  "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
  "```",
  "Not yet a formula: $\\notacommand{x}$",
].join("\n");

test("formulas in light and dark", async () => {
  const channelId = await fx.createChannel(`e2e-formulas-${suffix}`);
  await fx.send(channelId, DEV_BROWSER_USER.id, BODY);

  await fx.open(channelId);
  await until(`document.querySelectorAll(".message-markdown .katex").length >= 5`, 60_000);
  // Two in text, three on their own; prices stay text; the unknown command shows its source.
  expect(
    await evaluate<number>(`document.querySelectorAll(".message-markdown-formula").length`),
  ).toBe(3);
  expect(
    await evaluate<number>(`document.querySelectorAll(".message-markdown-formula-inline").length`),
  ).toBe(2);
  const text = await evaluate<string>(`document.querySelector(".message-markdown").innerText`);
  expect(text).toContain("It costs $5 to $10.");
  expect(text).toContain("\\notacommand{x}");
  await fx.screenshot("light.png");

  await evaluate(`localStorage.setItem("coforge-theme", "dark")`);
  try {
    await fx.open(channelId);
    await until(`document.querySelectorAll(".message-markdown .katex").length >= 5`, 60_000);
    await fx.screenshot("dark.png");
  } finally {
    await evaluate(`localStorage.removeItem("coforge-theme")`);
  }
}, 240_000);
