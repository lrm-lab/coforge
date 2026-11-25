import { animationsSettled, pageHydrated } from "./browser-e2e";

type Session = {
  browser: (...args: string[]) => Promise<string>;
  evaluate: <T>(expression: string) => Promise<T>;
};

const dialogs = `[...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')]`;
const dialog = `${dialogs}.at(-1)`;
const more = `document.querySelector('main header button[aria-label="More actions"]')`;
const pill = `document.querySelector('main header [aria-label^="Who can see:"]')`;
const shareButton = `document.querySelector('main header button[data-artifact-share]')`;
const shareDialog = `document.querySelector('[role="dialog"][aria-label="Share"]')`;
const versionChip = `document.querySelector('main header button[aria-label$=", switch version"]')`;
const menuItem = (label: string) =>
  `[...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].find((i) => i.textContent.trim().startsWith(${JSON.stringify(label)}))`;
const bannerButton = (label: string) =>
  `[...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;

export const artifactViewerReady = `${pageHydrated} && document.querySelector("main [data-artifact-markdown]") != null`;
export const artifactChromeReady = `${pageHydrated} && ${pill} != null`;
export const artifactChromeText = (needle: string) =>
  `document.body.textContent.includes(${JSON.stringify(needle)})`;

export function artifactChrome({ browser, evaluate }: Session) {
  const until = async (expression: string, attempts = 100) => {
    for (let i = 0; i < attempts; i++) {
      if (await evaluate<boolean>(expression).catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  const press = async (selector: string) => {
    await evaluate(`(${selector}.setAttribute("data-press", ""), true)`);
    await browser("click", "[data-press]");
    await evaluate(`(document.querySelector("[data-press]")?.removeAttribute("data-press"), true)`);
  };
  const pressMenuItem = async (label: string) => {
    await until(`${menuItem(label)} != null`);
    await press(menuItem(label));
  };
  const openMore = async () => {
    await until(`${more} != null`);
    await press(more);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[data-cascade-level="root"]')?.getAnimations().every((animation) => animation.playState !== "running") === true`,
    );
  };
  const closeMenus = async () => {
    await browser("press", "Escape");
    await until(`document.querySelector('[role="menu"]') == null`);
  };
  const openShare = async () => {
    await until(`${shareButton} != null`);
    await press(shareButton);
    await until(`${shareDialog} != null`);
    await browser("wait", "--fn", animationsSettled());
  };
  const closeShare = async () => {
    if (await evaluate<boolean>(`${shareDialog} != null`)) {
      await browser("press", "Escape");
      await until(`${shareDialog} == null`);
    }
  };
  return {
    until,
    press,
    openMore,
    openShare,
    closeShare,
    shareChangeable: () =>
      evaluate<boolean>(
        `(${shareDialog}?.querySelectorAll(":scope > section > div > button").length ?? 0) > 0`,
      ),
    shareChoices: () =>
      evaluate<string[]>(
        `[...(${shareDialog}?.querySelectorAll(":scope > section > div > :is(button, div)") ?? [])].map((el) => el.querySelector("span")?.textContent.trim() ?? "").filter(Boolean)`,
      ),
    selectedShareScope: () =>
      evaluate<string | null>(
        `(() => { const list = ${shareDialog}?.querySelector(":scope > section > div"); if (!list) return null; const buttons = [...list.querySelectorAll(":scope > button")]; if (buttons.length > 0) return buttons.find((b) => b.querySelectorAll("svg").length >= 2)?.querySelector("span")?.textContent.trim() ?? null; return list.querySelector(":scope > div span")?.textContent.trim() ?? null; })()`,
      ),
    chooseFromShare: async (scope: string) => {
      if (!(await evaluate<boolean>(`${shareDialog} != null`))) await openShare();
      const target = `[...${shareDialog}.querySelectorAll(":scope > section > div > button")].find((b) => b.querySelector("span")?.textContent.trim() === ${JSON.stringify(scope)})`;
      await until(`${target} != null`);
      await press(target);
      await until(`${shareDialog} == null`);
    },
    untilShareScope: async (scope: string) => {
      await openShare();
      await until(
        `(() => { const list = ${shareDialog}?.querySelector(":scope > section > div"); if (!list) return false; const buttons = [...list.querySelectorAll(":scope > button")]; const selected = buttons.length > 0 ? buttons.find((b) => b.querySelectorAll("svg").length >= 2)?.querySelector("span")?.textContent.trim() : list.querySelector(":scope > div span")?.textContent.trim(); return selected === ${JSON.stringify(scope)}; })()`,
      );
      await closeShare();
    },
    shareFooterButtons: () =>
      evaluate<string[]>(
        `[...(${shareDialog}?.querySelectorAll(":scope > div button") ?? [])].map((b) => b.textContent.trim()).filter(Boolean)`,
      ),
    moreItems: () =>
      evaluate<string[]>(
        `[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((i) => i.textContent.trim())`,
      ),
    pressMenuItem,
    closeMenus,
    pillScope: () =>
      evaluate<string>(
        `${pill}?.getAttribute("aria-label").replace(/^Who can see: /, "").replace(/\\. Change who can see$/, "")`,
      ),
    untilPillScope: (scope: string) =>
      until(`${pill}?.getAttribute("aria-label").includes(${JSON.stringify(`: ${scope}`)})`),
    pillChangeable: () => evaluate<boolean>(`${pill}?.tagName === "BUTTON"`),
    chooseFromPill: async (scope: string) => {
      await press(pill);
      await pressMenuItem(scope);
    },
    chooseFromMore: async (scope: string) => {
      await openMore();
      await press(menuItem("Who can see"));
      await pressMenuItem(scope);
    },
    selectedScope: () =>
      evaluate<string | null>(
        `[...document.querySelectorAll('[role="menuitemradio"]')].find((i) => i.getAttribute("aria-checked") === "true")?.textContent.trim() ?? null`,
      ),
    dialogText: () => evaluate<string>(`${dialog}?.textContent ?? ""`),
    confirmDialog: async (label: string) => {
      await press(
        `[...${dialog}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`,
      );
      await until(`!document.body.textContent.includes(${JSON.stringify(label)})`);
      await browser("wait", "--fn", animationsSettled());
    },
    openVersionMenu: async () => {
      await until(`${versionChip} != null`);
      await press(versionChip);
      await until(`document.querySelector('[role="menu"]') != null`);
    },
    versionChipText: () => evaluate<string | null>(`${versionChip}?.textContent.trim() ?? null`),
    pressBanner: (label: string) => press(bannerButton(label)),
    bannerPresent: (label: string) => evaluate<boolean>(`${bannerButton(label)} != null`),
  };
}
