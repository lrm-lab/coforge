import { join } from "node:path";
import type { browserSession } from "./browser-e2e";

/**
 * The Settings → Labels page as `e2e-label-settings` drives it: its rows, buttons and menus as
 * page expressions, real clicks on marked elements, and light and dark screenshots under
 * `artifacts`.
 */
export function labelSettingsPage(
  { browser, evaluate }: ReturnType<typeof browserSession>,
  artifacts: string,
) {
  const row = (label: string) =>
    `document.querySelector('[data-label-row=${JSON.stringify(label)}]')`;
  const button = (text: string, within = "document") =>
    `[...${within}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
  const item = (text: string) =>
    `[...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;
  const click = (selector: string) => evaluate(`(${selector}.click(), true)`);
  const settled = `document.getAnimations().every((a) => a.playState !== "running")`;
  const shoot = async (shot: string) => {
    await browser("wait", "--fn", settled);
    await browser("screenshot", join(artifacts, `${shot}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, `${shot}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  const menu = async (label: string, action: string) => {
    await browser("wait", "--fn", `${dialogsOpen} === 0 && ${settled}`);
    // An earlier row's mark would be clicked first.
    await evaluate(
      `([...document.querySelectorAll("[data-e2e]")].forEach((el) => el.removeAttribute("data-e2e")), true)`,
    );
    await evaluate(
      `(${row(label)}.querySelector('button[aria-label="Actions for ${label}"]').setAttribute("data-e2e", "more"), true)`,
    );
    await browser("click", '[data-e2e="more"]');
    await browser("wait", "--fn", `${item(action)} !== undefined`);
    await evaluate(`(${item(action)}.setAttribute("data-e2e", "item"), true)`);
    await browser("click", '[data-e2e="item"]');
  };
  const dialogsOpen = `document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length`;
  /** A real click on what `selector` names, marked for the browser to find. */
  const press = async (selector: string) => {
    await browser(
      "wait",
      "--fn",
      `${dialogsOpen} === 0 && ${selector} != null && !(${selector})?.disabled && ${settled}`,
    );
    await evaluate(
      `([...document.querySelectorAll("[data-e2e]")].forEach((el) => el.removeAttribute("data-e2e")), ${selector}.setAttribute("data-e2e", "press"), true)`,
    );
    await browser("click", '[data-e2e="press"]');
  };
  return { row, button, item, click, settled, shoot, menu, dialogsOpen, press };
}
