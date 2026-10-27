import { expect, test } from "bun:test";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

/**
 * Browser E2E (task #181): the notification banner above the composer keeps its text readable. Its
 * buttons sit beside the body only while the body keeps 280px; in a narrower pane (beside an open
 * thread, a phone, or the 440–550px panes checked here) they take their own row under it, so the
 * text is never squeezed into a narrow column. Opt-in like the other browser E2Es (it reuses the
 * replying fixture's channel and thread); see `helpers/agent-replying-fixture.ts`. Screenshots are
 * written under `.amp/e2e/notification-banner/`.
 */
const fx = setupAgentReplying({ artifactsName: "notification-banner" });
const { suffix, browser, evaluate, until } = fx;

/** Where the banner's Enable button sits against its body text, how wide that text is and how tall
 * the button is (32px, as on Raft). */
const layout = `(() => {
  const enable = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Enable Notifications");
  const body = enable?.closest(".rounded-xl")?.querySelector(".basis-70");
  if (!enable || !body) return null;
  const e = enable.getBoundingClientRect();
  const b = body.getBoundingClientRect();
  return { beside: e.left >= b.right, below: e.top >= b.bottom, bodyWidth: Math.round(b.width), buttonHeight: Math.round(e.height) };
})()`;
type Layout = { beside: boolean; below: boolean; bodyWidth: number; buttonHeight: number } | null;
const bannerShown = `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Enable Notifications")`;

test("the banner's buttons move under its text when the pane narrows", async () => {
  await browser("set", "viewport", "1440", "900");
  await fx.open(fx.joinedId);
  await fx.untilText(`Thread root ${suffix}`);
  await until(bannerShown);
  const wide = await evaluate<Layout>(layout);
  expect(wide).toMatchObject({ beside: true, below: false, buttonHeight: 32 });
  expect(wide!.bodyWidth).toBeGreaterThanOrEqual(280);
  await fx.screenshot("wide.png");

  // A conversation pane of these widths (the banner's 24px margins included) leaves the body under
  // 280px beside the buttons, so they wrap.
  for (const pane of [440, 460, 550]) {
    await browser(
      "eval",
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Enable Notifications").closest(".rounded-xl").parentElement.style.width = "${pane - 48}px"`,
    );
    const narrow = await evaluate<Layout>(layout);
    expect(narrow).toMatchObject({ beside: false, below: true });
    await fx.screenshot(`pane-${pane}.png`);
  }

  // The thread pane leaves the conversation about 430px.
  await fx.open(fx.joinedId, `?threadRootId=${fx.rootId}`);
  await fx.untilText(`First reply ${suffix}`);
  await until(bannerShown);
  const threadOpen = await evaluate<Layout>(layout);
  expect(threadOpen).toMatchObject({ beside: false, below: true });
  expect(threadOpen!.bodyWidth).toBeGreaterThan(250);
  await fx.screenshot("thread-open.png");

  await browser("set", "viewport", "390", "844");
  await fx.open(fx.joinedId);
  await fx.untilText(`Thread root ${suffix}`);
  await until(bannerShown);
  const phone = await evaluate<Layout>(layout);
  expect(phone).toMatchObject({ beside: false, below: true });
  await fx.screenshot("phone.png");
}, 240_000);
