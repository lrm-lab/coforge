import { expect } from "bun:test";
import type { artifactChrome } from "./artifact-chrome";
import type { browserSession } from "./browser-e2e";

const text = (needle: string) => `document.body.textContent.includes(${JSON.stringify(needle)})`;

/**
 * What a web page's viewer shows around versions, for a page showing v2 of an artifact an Agent
 * is about to publish v3 of: the live "published v3" banner (the page keeps v2 until View latest),
 * the version switcher with "Viewing v1" and Back to latest, the files panel, and rename, which
 * keeps the version.
 */
export async function versionChromeSteps(input: {
  session: ReturnType<typeof browserSession>;
  chrome: ReturnType<typeof artifactChrome>;
  until: (expression: string) => Promise<void>;
  shoot: (name: string) => Promise<void>;
  publish: () => Promise<unknown>;
  publisher: string;
  frame: string;
  renameTo: string;
  currentVersion: () => Promise<number>;
}) {
  const { chrome, until, shoot } = input;
  const { browser, evaluate } = input.session;
  const frameSource = `document.querySelector("main iframe").src`;

  await input.publish();
  await until(
    `document.querySelector("main").textContent.includes(${JSON.stringify(`${input.publisher} published v3`)})`,
  );
  expect(await chrome.versionChipText()).toBe("v2");
  expect(await evaluate<string>(frameSource)).toBe(input.frame);
  await shoot("2-banner");
  await chrome.pressBanner("View latest");
  await until(
    `document.querySelector("main iframe") != null && ${frameSource} !== ${JSON.stringify(input.frame)}`,
  );
  expect(await chrome.versionChipText()).toBe("v3");
  expect(await chrome.bannerPresent("View latest")).toBe(false);

  await chrome.openVersionMenu();
  expect(
    await evaluate<string[]>(
      `[...document.querySelectorAll('[role="menuitemradio"]')].map((i) => i.textContent.trim().slice(0, 2))`,
    ),
  ).toEqual(["v3", "v2", "v1"]);
  await shoot("2b-switcher");
  await chrome.pressMenuItem("v1");
  await until(text("Viewing v1"));
  expect(await chrome.versionChipText()).toBe("v1");
  await shoot("2c-old-version");
  await chrome.pressBanner("Back to latest");
  await until(`!${text("Viewing v1")}`);
  expect(await chrome.versionChipText()).toBe("v3");

  const panel = `document.querySelector('aside[aria-label="Files"]')`;
  await chrome.openMore();
  await chrome.pressMenuItem("Files");
  await until(`${panel}?.textContent.includes("index.html")`);
  expect(await evaluate<string>(`${panel}.querySelector("p").textContent`)).toStartWith("1 files");
  await shoot("2d-files");
  await chrome.press(`${panel}.querySelector("button")`);
  await until(`${panel} == null`);

  await chrome.openMore();
  await chrome.pressMenuItem("Rename");
  await until(`document.querySelector('[role="dialog"] input') != null`);
  await browser("fill", '[role="dialog"] input', input.renameTo);
  await chrome.press(
    `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Save")`,
  );
  await until(
    `document.querySelector("main header h1")?.textContent === ${JSON.stringify(input.renameTo)}`,
  );
  expect(await chrome.versionChipText()).toBe("v3");
  expect(await input.currentVersion()).toBe(3);
}
