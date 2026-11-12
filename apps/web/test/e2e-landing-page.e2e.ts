import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  openBrowser,
  requireLocalServices,
  startSignInStack,
  type Person,
} from "./e2e-sign-in-harness";

/**
 * The public homepage, jing's v8 (#designers:#4). On a desktop it is one 1440 x 900 screen scaled
 * to the window, so at every common window size nothing scrolls and the feature card is whole on
 * screen; on a phone it is a column that scrolls. It stays light in the dark theme, reads in
 * English too (as text; Chinese is the designer's lettering), and its agents keep still for someone who asked for less motion. Shoots 1440, 1920,
 * 768 and 390, Chinese and English, light and dark, under `.amp/e2e/landing-page/`.
 *
 * Opt-in like the other browser E2Es, and brings its own servers (`e2e-sign-in-harness.ts`), so
 * the page is seen signed out:
 *
 *   REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-landing-page.e2e.ts
 */
requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_SIGN_IN_WEB_PORT ?? 8798);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/landing-page");
const people: Record<string, Person> = {};

/** Window sizes people sign in from, the toolbar's share taken: none of them scrolls. */
const DESKTOP = [
  [1280, 600],
  [1280, 690],
  [1280, 720],
  [1280, 800],
  [1366, 657],
  [1366, 768],
  [1440, 790],
  [1440, 900],
  [1536, 730],
  [1536, 864],
  [1920, 960],
  [1920, 1080],
  [2560, 1440],
] as const;

test("the homepage: one screen on a desktop, a column on a phone, always light", async () => {
  const { browser, evaluate, waitFor } = openBrowser(`landing-page-${process.pid}`);
  const stack = await startSignInStack({ people, webPort, artifacts });
  const viewport = (width: number, height: number) =>
    browser("set", "viewport", String(width), String(height));
  const open = async (locale: string) => {
    await browser("open", `${stack.origin}/${locale}`);
    await waitFor(
      `!!document.querySelector(".home-features li img") && document.fonts.status === "loaded"`,
    );
    // Every picture decoded, so a shot never catches a layer half drawn.
    await evaluate(
      `Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))).then(() => true)`,
    );
  };
  const shot = (name: string) => browser("screenshot", join(artifacts, `${name}.png`));
  const box = (selector: string) =>
    evaluate<{ top: number; bottom: number; left: number; right: number }>(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`,
    );

  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "headers", JSON.stringify({ "X-Forwarded-For": "198.51.100.61" }));
    await viewport(1440, 900);
    await open("zh-CN");
    expect(await evaluate<string>(`document.title`)).toContain("共同进化");
    expect(await evaluate<string>(`document.querySelector("h1").textContent`)).toContain(
      "共同进化",
    );
    // Both account links go to sign-in; the old install terminal is gone.
    expect(
      await evaluate<string[]>(
        `[...document.querySelectorAll(".home-nav-actions a[href]")].map((a) => new URL(a.href).pathname)`,
      ),
    ).toEqual(expect.arrayContaining(["/zh-CN/login"]));
    expect(await evaluate<boolean>(`!!document.querySelector('[role="region"] pre')`)).toBe(false);
    // In Chinese the headline is the designer's lettering, its words still there to read.
    expect(
      await evaluate<boolean>(
        `document.querySelector(".home-lettering").getBoundingClientRect().width > 400`,
      ),
    ).toBe(true);

    // One screen at every common desktop size: no scroll either way, the card whole on screen.
    const failures: string[] = [];
    for (const [width, height] of DESKTOP) {
      await viewport(width, height);
      await browser("wait", "200");
      const fit = await evaluate<{ sh: number; sw: number; ih: number; iw: number }>(
        `({ sh: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth, ih: innerHeight, iw: innerWidth })`,
      );
      const card = await box(".home-features");
      if (fit.sh > fit.ih || fit.sw > fit.iw || card.bottom > fit.ih || card.top < 0)
        failures.push(`${width}x${height} ${JSON.stringify({ ...fit, card })}`);
    }
    expect(failures).toEqual([]);

    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
    ] as const) {
      await viewport(width, height);
      await browser("wait", "300");
      await shot(`zh-CN-${width}`);
    }
    // The logo sits where the sign-in page puts it (`login-art.css`): 16.25 and 79 design px in,
    // at s = min(innerWidth / 1440, innerHeight / 900, 1.5), the design centred.
    await viewport(1440, 900);
    await browser("wait", "200");
    const logo = await box(".home-logo img");
    expect(Math.abs(logo.top - 16)).toBeLessThan(2);
    expect(Math.abs(logo.left - 79)).toBeLessThan(2);

    // Light in the dark theme too (jing, 11-12).
    await evaluate(`(document.documentElement.classList.add("dark-mode"), true)`);
    await browser("wait", "200");
    expect(
      await evaluate<string>(
        `getComputedStyle(document.querySelector(".home-page")).backgroundColor`,
      ),
    ).toBe("rgb(238, 235, 254)");
    expect(
      await evaluate<string>(`getComputedStyle(document.querySelector(".home-title")).color`),
    ).toBe("rgb(16, 19, 25)");
    await shot("zh-CN-1440-dark-theme");
    await evaluate(`(document.documentElement.classList.remove("dark-mode"), true)`);

    // English reads as text, in the same box.
    await open("en");
    expect(await evaluate<string>(`document.querySelector("h1").textContent`)).toContain(
      "together",
    );
    expect(await evaluate<boolean>(`!document.querySelector(".home-lettering")`)).toBe(true);
    expect(await evaluate<boolean>(`document.documentElement.scrollHeight <= innerHeight`)).toBe(
      true,
    );
    await shot("en-1440");

    // A tablet and a phone: a column that scrolls, nothing wider than the window, the language
    // switch kept beside the account links on the phone (jing, 11-12).
    for (const [width, height] of [
      [768, 1024],
      [390, 844],
    ] as const) {
      await viewport(width, height);
      for (const locale of ["zh-CN", "en"]) {
        await open(locale);
        expect(await evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
          true,
        );
        expect(
          await evaluate<boolean>(
            `document.querySelector(".home-lang").getBoundingClientRect().width > 0`,
          ),
        ).toBe(true);
        await shot(`${locale}-${width}`);
        await browser("screenshot", "--full", join(artifacts, `${locale}-${width}-full.png`));
      }
    }

    // Less motion: the agents keep still.
    await viewport(1440, 900);
    await browser("set", "media", "reduced-motion");
    await open("zh-CN");
    expect(
      await evaluate<string>(
        `getComputedStyle(document.querySelector(".home-agent")).animationName`,
      ),
    ).toBe("none");
  } finally {
    await browser("close").catch(() => undefined);
    await stack.stop();
  }
}, 300_000);
