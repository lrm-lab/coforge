import { pageHydrated } from "./browser-e2e";

type Session = {
  browser: (...args: string[]) => Promise<string>;
  evaluate: <T>(expression: string) => Promise<T>;
};

const dialogs = `[...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')]`;
const dialog = `${dialogs}.at(-1)`;
const more = `document.querySelector('main header button[aria-label="More actions"]')`;
const pill = `document.querySelector('main header [aria-label^="Who can see:"]')`;
const versionChip = `document.querySelector('main header button[aria-label$=", switch version"]')`;
const menuItem = (label: string) =>
  `[...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].find((i) => i.textContent.trim().startsWith(${JSON.stringify(label)}))`;
const bannerButton = (label: string) =>
  `[...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;

export const artifactViewerReady = `${pageHydrated} && document.querySelector("main .ProseMirror") != null`;
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
  return {
    until,
    press,
    openMore,
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
      await browser(
        "wait",
        "--fn",
        `document.getAnimations().every((a) => a.playState !== "running")`,
      );
    },
    openVersionMenu: async () => {
      await until(`${versionChip} != null`);
      await press(versionChip);
      await until(`document.querySelector('[role="menu"]') != null`);
    },
    versionChipText: () => evaluate<string>(`${versionChip}?.textContent.trim()`),
    pressBanner: (label: string) => press(bannerButton(label)),
    bannerPresent: (label: string) => evaluate<boolean>(`${bannerButton(label)} != null`),
  };
}
