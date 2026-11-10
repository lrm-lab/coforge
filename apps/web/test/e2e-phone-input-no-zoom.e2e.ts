import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageDevtools } from "./helpers/browser-e2e";

/**
 * iOS Safari zooms the page into a focused text field whose text is under 16px and stays zoomed,
 * so on a touch screen no text field is under 16px, while one designed larger keeps its size
 * (styles.css, docs/design/typography.md). agent-browser has no device switch that changes
 * `pointer`, so the test turns on Chrome's touch emulation over the DevTools protocol, which does.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();

/** The members page's Agent search: a 14px Untitled UI `sm` Input, the field the iPhone zoomed. */
const SEARCH = `document.querySelector('input[placeholder="Search agents..."]')`;

/**
 * One of each kind of field the rule covers, under a 14px parent, built from the app's own
 * utilities: a `text-sm` input, a `text-xl` title, a textarea with no size of its own, and an
 * editable area with a `text-sm` paragraph. Returns `[font size, line height]` per fixture.
 */
const FIXTURE_SIZES = `(() => {
  let box = document.getElementById('phone-input-fixtures');
  if (!box) {
    box = document.createElement('div');
    box.id = 'phone-input-fixtures';
    box.className = 'text-sm';
    box.innerHTML = '<input data-f="small" class="text-sm"><input data-f="title" class="text-xl">'
      + '<textarea data-f="inherited"></textarea>'
      + '<div contenteditable="true"><p data-f="paragraph" class="text-sm">x</p></div>';
    document.body.append(box);
  }
  return Object.fromEntries([...box.querySelectorAll('[data-f]')].map((field) => {
    const style = getComputedStyle(field);
    return [field.dataset.f, [parseFloat(style.fontSize), parseFloat(style.lineHeight)]];
  }));
})()`;

const size = (expression: string) => `parseFloat(getComputedStyle(${expression}).fontSize)`;

test("on a touch screen no text field is under 16px, so iOS never zooms into it", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `phone-input-zoom-${process.pid}`,
  );
  let devtools: Awaited<ReturnType<typeof pageDevtools>> | undefined;
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${membership.workspace.slug}/members`);
    await waitFor(`${SEARCH} !== null`, 60_000);

    // With a mouse every field keeps its designed size.
    expect(await evaluate<number>(size(SEARCH))).toBe(14);
    expect(await evaluate(FIXTURE_SIZES)).toEqual({
      small: [14, 20],
      title: [20, 30],
      inherited: [14, 20],
      paragraph: [14, 20],
    });

    devtools = await pageDevtools(browser, "/members");
    await devtools.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await waitFor(`matchMedia("(pointer: coarse)").matches`);

    // With touch the small ones become 16/24; the title stays as designed.
    expect(await evaluate<number>(size(SEARCH))).toBe(16);
    expect(await evaluate(FIXTURE_SIZES)).toEqual({
      small: [16, 24],
      title: [20, 30],
      inherited: [16, 20],
      paragraph: [16, 24],
    });
  } finally {
    devtools?.close();
    await browser("close").catch(() => {});
    await db.$disconnect();
  }
}, 120_000);
