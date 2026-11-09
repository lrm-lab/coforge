import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { githubClientId, githubConnection, startFakeGithub } from "./e2e-fake-github";
import {
  accountFieldSelector,
  codeFieldSelector,
  codeTab,
  destinationFieldSelector,
  onSignInPage,
  openBrowser,
  passwordFieldSelector,
  passwordTab,
  requireLocalServices,
  signInTab,
  startSignInStack,
  type Person,
} from "./e2e-sign-in-harness";

/**
 * The split sign-in page: the brand panel (arch, agent, tagline, platforms) beside the form from
 * `lg` up, the form alone below it. Checks the two tabs, the fields each shows, the password tab's
 * "email code" link and its way back, and that the brand panel is there at 1440 and 1024 and gone
 * at 390 (where the form must still fit the width), then shoots the page at 1440, 768 and 390,
 * light and dark, under `.amp/e2e/login-split/`.
 *
 * Opt-in like the other browser E2Es, and brings its own servers (`e2e-sign-in-harness.ts`):
 *
 *   REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-login-split.e2e.ts
 */
requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_SIGN_IN_WEB_PORT ?? 8798);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/login-split");
const people: Record<string, Person> = {};

test("the split sign-in page: tabs, fields, email-code link and screenshots", async () => {
  const { browser, evaluate, waitFor, button } = openBrowser(`login-split-${process.pid}`);
  const github = startFakeGithub();
  const stack = await startSignInStack({
    people,
    webPort,
    artifacts,
    github: { connection: githubConnection, consume: github.consume },
    env: {
      COFORGE_GITHUB_SIGN_IN_CLIENT_ID: githubClientId,
      AUTHING_GITHUB_CONNECTION: githubConnection,
      COFORGE_GITHUB_SIGN_IN_AUTHORIZE_URL: github.authorizeUrl,
    },
  });
  const style = (selector: string, property: string) =>
    evaluate<string>(
      `getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(property)}]`,
    );
  const titleTop = () =>
    evaluate<number>(`document.querySelector("h1").getBoundingClientRect().top`);
  const tabColor = (tab: string) => evaluate<string>(`getComputedStyle(${tab}).color`);
  const fieldGroup = (selector: string) =>
    `document.querySelector(${JSON.stringify(selector)}).closest('[class~="group/input"]')`;
  const exists = (selector: string) =>
    evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
  const selected = (tab: string) => evaluate<string>(`${tab}.getAttribute("aria-selected")`);
  /** Whether the brand panel (its logo list and illustration) is on screen. */
  const brandVisible = () =>
    evaluate<boolean>(
      `(() => { const art = document.querySelector(".login-art"); return !!art && art.getBoundingClientRect().width > 0; })()`,
    );
  /** Nothing on the page is wider than the window. */
  const fits = () => evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`);
  const setViewport = (width: number) => browser("set", "viewport", String(width), "900");
  const setDark = (dark: boolean) =>
    evaluate(`document.documentElement.classList.${dark ? "add" : "remove"}("dark-mode") ?? true`);

  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "headers", JSON.stringify({ "X-Forwarded-For": "198.51.100.50" }));
    await setViewport(1440);
    await browser("open", `${stack.origin}/login`);
    await waitFor(onSignInPage(stack.origin));

    // The phone tab leads: a phone field, a code field with its send button, the submit button.
    expect(await selected(codeTab)).toBe("true");
    expect(await exists(destinationFieldSelector)).toBe(true);
    expect(await exists(codeFieldSelector)).toBe(true);
    expect(await exists(passwordFieldSelector)).toBe(false);
    expect(await evaluate<boolean>(`!!${button("Send code")}`)).toBe(true);
    expect(await evaluate<boolean>(`!!${button("Sign in")}`)).toBe(true);
    expect(await brandVisible()).toBe(true);

    // The homepage's logo, the selected tab in brand purple and the other grey, GitHub below the
    // submit button (full width) on this tab only.
    expect(
      await evaluate<string>(
        `document.querySelector(".login-brand-logo img")?.getAttribute("src")`,
      ),
    ).toBe("/login/homepage-logo.webp");
    // Where the homepage puts its logo at 1440: 79 px in, centred in its 75 px bar, 170 px wide.
    expect(
      await evaluate<number[]>(
        `(() => { const r = document.querySelector(".login-brand-logo").getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)]; })()`,
      ),
    ).toEqual([79, 16, 170]);
    expect(await tabColor(codeTab)).toBe("rgb(93, 54, 220)");
    expect(await tabColor(passwordTab)).toBe("rgb(119, 125, 141)");
    expect(await evaluate<boolean>(`!!${button("Continue with GitHub")}`)).toBe(true);
    const phoneTitleTop = await titleTop();
    const fieldLook = () =>
      evaluate<{ border: string; shadow: string }>(
        `(() => { const s = getComputedStyle(${fieldGroup(destinationFieldSelector)}); return { border: s.borderTopWidth + " " + s.borderTopColor, shadow: s.boxShadow }; })()`,
      );
    // Nothing has the focus on arrival, so the phone field shows its resting look: 1px #E0E5F1.
    const resting = await fieldLook();
    expect(resting.border).toBe("1px rgb(224, 229, 241)");
    expect(resting.shadow).not.toContain("0px 0px 0px 4px");
    // Typing in it: 1px #C2B3F6 border and the two shadows.
    await browser(
      "eval",
      `document.querySelector(${JSON.stringify(destinationFieldSelector)}).focus()`,
    );
    await browser("wait", "200");
    const focused = await fieldLook();
    expect(focused.border).toBe("1px rgb(194, 179, 246)");
    expect(focused.shadow).toContain("rgb(234, 228, 253) 0px 0px 0px 4px");
    expect(focused.shadow).toContain("0px 1px 2px");
    expect(
      await evaluate<string>(
        `getComputedStyle(document.querySelector(${JSON.stringify(codeFieldSelector)}), "::placeholder").color`,
      ),
    ).toBe("rgb(119, 125, 141)");

    // The password tab: account and password, the submit button, then the two links of one row.
    await browser("eval", `${passwordTab}.click()`);
    await waitFor(`!!document.querySelector(${JSON.stringify(accountFieldSelector)})`);
    expect(await selected(passwordTab)).toBe("true");
    // The tab colours ease over 100 ms.
    await browser("wait", "300");
    expect(await tabColor(passwordTab)).toBe("rgb(93, 54, 220)");
    expect(await tabColor(codeTab)).toBe("rgb(119, 125, 141)");
    // Switching tabs leaves the title where it was, and GitHub is the phone tab's alone.
    expect(await titleTop()).toBe(phoneTitleTop);
    expect(await evaluate<boolean>(`!!${button("Continue with GitHub")}`)).toBe(false);
    expect(await evaluate<boolean>(`!!${button("Sign in")}`)).toBe(true);
    expect(await exists(passwordFieldSelector)).toBe(true);
    expect(await exists(destinationFieldSelector)).toBe(false);
    expect(await evaluate<boolean>(`!!${button("Forgot password?")}`)).toBe(true);
    expect(await evaluate<boolean>(`!!${button("Sign in with an email code")}`)).toBe(true);

    // "Sign in with an email code" opens the code tab worded for an email, with a way back.
    await browser("eval", `${button("Sign in with an email code")}.click()`);
    await waitFor(`!!document.querySelector(${JSON.stringify(destinationFieldSelector)})`);
    expect(await selected(signInTab("Email code"))).toBe("true");
    expect(
      await evaluate<string>(
        `document.querySelector(${JSON.stringify(destinationFieldSelector)}).placeholder`,
      ),
    ).toBe("Email address");
    await browser("eval", `${button("Phone")}.click()`);
    await waitFor(`!!${codeTab}`);
    expect(await selected(codeTab)).toBe("true");

    // The screens, in each width and theme.
    for (const width of [1440, 768, 390]) {
      await setViewport(width);
      await browser("wait", "300");
      // The panel shows from `lg` (1024) up only, and the form always fits the window.
      expect(await brandVisible()).toBe(width >= 1024);
      expect(await fits()).toBe(true);
      for (const [tab, name] of [
        [codeTab, "phone"],
        [passwordTab, "password"],
      ] as const) {
        await browser("eval", `${tab}.click()`);
        await browser("wait", "300");
        for (const dark of [false, true]) {
          await setDark(dark);
          await browser(
            "screenshot",
            join(artifacts, `${name}-${width}-${dark ? "dark" : "light"}.png`),
          );
        }
        await setDark(false);
      }
    }

    // The agent floats and the shadow breathes on one beat, unless motion is reduced.
    await setViewport(1440);
    await browser("hover", ".login-art");
    await browser("wait", "500");
    // Only the white door swings, not the frame around it, hinged on its body's right edge (the
    // layer's glow reaches past it).
    expect(await style(".login-art__door", "transform")).not.toBe("none");
    expect(await style(".login-art__door", "transformOrigin")).toMatch(/^[\d.]+px /);
    expect(
      await evaluate<boolean>(
        `(() => { const d = document.querySelector(".login-art__door"); const x = parseFloat(getComputedStyle(d).transformOrigin) / d.offsetWidth; return x > 0.89 && x < 0.92; })()`,
      ),
    ).toBe(true);
    expect(await style(".login-art__frame", "transform")).toBe("none");
    await browser("screenshot", join(artifacts, "arch-open-1440.png"));
    await browser("mouse", "move", "1200", "100");
    const animations = await evaluate<{ agent: string; shadow: string }>(
      `({ agent: getComputedStyle(document.querySelector(".login-art__agent")).animationDuration, shadow: getComputedStyle(document.querySelector(".login-art__shadow")).animationDuration })`,
    );
    expect(animations.agent).toBe(animations.shadow);
    // The designer's copy, in Chinese.
    await browser("open", `${stack.origin}/zh-CN/login`);
    await browser("wait", "--fn", `document.querySelector(".login-art") !== null`);
    await browser("wait", "500");
    await browser("screenshot", join(artifacts, "zh-1440.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await stack.stop();
  }
}, 300_000);
