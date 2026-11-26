import { expect, test } from "bun:test";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { setupAgentReplying, announced, visible } from "./helpers/agent-replying-fixture";

/**
 * An Agent about to post is shown to the people who can read the place: "<Agent> is replying"
 * under a thread's root in the channel's stream (gone once the Agent's reply lands in the thread,
 * with no `end` frame), "<Agent> is typing…" at the foot of a conversation pane even for a viewer
 * who cannot write there, and neither while Live agent activity is off on this device.
 *
 * The intents travel the real path: each frame is posted to the Web's
 * `/api/internal/centrifugo-agent-activity` as Centrifugo's publish proxy would post it (the Agent
 * must be on a registered Computer of the Workspace and its target must resolve), and the frame the
 * Web answers with is published on the Activity channel through Centrifugo's HTTP API, as Centrifugo
 * does with a proxy's `result`. The Agent's reply goes through the Agent API's send handler with
 * the route's own dependencies, so its realtime fan-out is the app's.
 *
 * Opt-in like the other browser E2Es: a real local Web built with `bun run build` and served from
 * `.output/` (`COFORGE_E2E_WEB_URL`), a real Centrifugo with this repository's
 * `infra/centrifugo/config.yaml` whose proxies and JWKS point at that Web
 * (`COFORGE_E2E_CENTRIFUGO_URL`), `COFORGE_CENTRIFUGO_API_URL`/`_API_KEY` for that Centrifugo,
 * `COFORGE_CENTRIFUGO_PROXY_SECRET` equal to the Web's, `DATABASE_URL`, `REDIS_URL`,
 * `agent-browser`, and the dev user an owner of its Workspace (seed-dev). The browser talks to a
 * proxy in this test that forwards `/connection/*` to Centrifugo and the rest to the Web. Each run
 * seeds a Computer, an Agent, two channels and a second member, and removes them afterwards.
 * Screenshots are written under `.artifacts/e2e/agent-replying/`. The setup is shared in `helpers/agent-replying-fixture.ts`.
 *
 * A reply intent ends where the Agent's message arrives in the browser's cache, not where it is
 * shown (`useConversationQuery`'s `mergeUpdates` tells the reply-intent store). Two consequences,
 * the last two tests:
 *
 * - A reply that lands before its call's start claims the next new start of that Agent in that
 *   place within 8s, so a late-arriving start (and its repeats) is never shown.
 * - A reply to a thread whose root is outside the loaded window still ends the intent, so jumping
 *   to that root afterwards does not show "<Agent> is replying" under it.
 */
const fx = setupAgentReplying({ artifactsName: "agent-replying" });
const { suffix, replyingSentence, typingSentence, evaluate, until, staysFalse, browser } = fx;
const { announce, agentSends, open, untilText } = fx;

test("an Agent about to reply shows under the thread's root until its reply lands", async () => {
  await open(fx.joinedId);
  await untilText(`Thread root ${suffix}`);
  // The browser stays on the channel's main view; only the stream's thread summary is on screen.
  const call = await announce(`#e2e-replying-${suffix}:${fx.rootId}`);
  try {
    await until(visible(replyingSentence));
    expect(await evaluate<boolean>(announced(replyingSentence))).toBe(true);
    // The thread is not the open place, so the pane's own line stays away.
    expect(await evaluate<boolean>(visible(typingSentence))).toBe(false);
    await fx.screenshot("replying-under-root.png");

    // The Agent's reply lands in the thread; no `end` frame is sent, and the start keeps repeating.
    await agentSends(`#e2e-replying-${suffix}:${fx.rootId}`, `Agent reply ${suffix}`);
    await until(`!(${visible(replyingSentence)})`);
    await fx.screenshot("reply-landed.png");
  } finally {
    call.stop();
  }

  // An `end` frame clears the line as well: announce again, then end without any reply.
  const second = await announce(`#e2e-replying-${suffix}:${fx.rootId}`);
  try {
    await until(visible(replyingSentence));
    await second.end();
    await until(`!(${visible(replyingSentence)})`);
  } finally {
    second.stop();
  }
}, 180_000);

test("a viewer who cannot write in the channel still sees who is typing", async () => {
  await open(fx.unjoinedId);
  await untilText(`Read-only channel message ${suffix}`);
  // There is no composer here: the dev user has not joined the channel.
  expect(
    await evaluate<boolean>(
      `document.querySelector("textarea, [contenteditable='true']") === null`,
    ),
  ).toBe(true);
  const call = await announce(`#e2e-readonly-${suffix}`);
  try {
    await until(visible(typingSentence));
    expect(await evaluate<boolean>(announced(typingSentence))).toBe(true);
    await fx.screenshot("typing-read-only.png");
  } finally {
    await call.end();
  }
  await until(`!(${visible(typingSentence)})`);
}, 180_000);

test("on a phone the typing line and the jump-to-latest pill do not cover each other", async () => {
  await browser("set", "viewport", "393", "852");
  try {
    const name = `e2e-pill-${suffix}`;
    const channelId = await fx.createChannel(name);
    for (let index = 1; index <= 40; index += 1)
      await fx.send(channelId, DEV_BROWSER_USER.id, `Filler ${index} ${suffix}`);
    await open(channelId);
    await untilText(`Filler 40 ${suffix}`);
    const pill = `[...document.querySelectorAll("button")].find((node) => node.textContent.trim() === "Jump to latest")`;
    await until(`(() => {
      const history = [...document.querySelectorAll("[data-conversation-pane] .overflow-y-auto")].find(
        (node) => node.scrollHeight > node.clientHeight,
      );
      if (history) history.scrollTop = 0;
      return Boolean(${pill}?.checkVisibility());
    })()`);
    const call = await announce(`#${name}`);
    try {
      await until(visible(typingSentence));
      const layout = await evaluate<{
        pillVisible: boolean;
        line: DOMRect | null;
        pill: DOMRect | null;
      }>(`(() => {
        const line = [...document.querySelectorAll(".replying-line")].find(
          (node) => node.textContent === ${JSON.stringify(typingSentence)},
        );
        const button = ${pill};
        return {
          pillVisible: Boolean(button?.checkVisibility()),
          line: line?.getBoundingClientRect() ?? null,
          pill: button?.getBoundingClientRect() ?? null,
        };
      })()`);
      expect(layout.pillVisible).toBe(true);
      expect(layout.line).not.toBeNull();
      const line = layout.line!;
      const jump = layout.pill!;
      const apart =
        line.right <= jump.left ||
        jump.right <= line.left ||
        line.bottom <= jump.top ||
        jump.bottom <= line.top;
      expect(apart).toBe(true);
      expect(Math.round(jump.width)).toBe(Math.round(jump.height));
      expect(jump.left).toBeGreaterThanOrEqual(line.right);
      const tappable = await evaluate<boolean>(`(() => {
        const button = ${pill};
        const box = button.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return [[-21.5, 0], [21.5, 0], [0, -21.5], [0, 21.5], [-21.5, -21.5], [21.5, 21.5]].every(
          ([dx, dy]) => button.contains(document.elementFromPoint(x + dx, y + dy)),
        );
      })()`);
      expect(tappable).toBe(true);
      await fx.screenshot("typing-phone.png");
    } finally {
      await call.end();
    }
  } finally {
    await browser("set", "viewport", "1440", "900");
  }
}, 180_000);

test("the jump-to-latest pill keeps its height above the composer, whatever the line below it says", async () => {
  const name = `e2e-pill-gap-${suffix}`;
  const channelId = await fx.createChannel(name);
  for (let index = 1; index <= 40; index += 1)
    await fx.send(channelId, DEV_BROWSER_USER.id, `Filler ${index} ${suffix}`);
  await open(channelId);
  await untilText(`Filler 40 ${suffix}`);
  const pill = `[...document.querySelectorAll("button")].find((node) => node.textContent.trim() === "Jump to latest")`;
  const history = `[...document.querySelectorAll("[data-conversation-pane] .overflow-y-auto")].find(
    (node) => node.scrollHeight > node.clientHeight,
  )`;
  const geometry = `(() => {
    const scroller = ${history};
    const button = ${pill};
    const line = [...document.querySelectorAll(".replying-line")].find(
      (node) => node.textContent === ${JSON.stringify(typingSentence)},
    );
    const shown = Boolean(button?.checkVisibility());
    const box = shown ? button.getBoundingClientRect() : null;
    const rect = line?.getBoundingClientRect();
    const grid = line?.closest("[class*='grid-cols-']");
    const outer = grid?.getBoundingClientRect();
    const pad = grid && getComputedStyle(grid);
    // The row's content box: its side padding is not width the line could take.
    const row = outer && pad && {
      left: outer.left + Number.parseFloat(pad.paddingLeft),
      right: outer.right - Number.parseFloat(pad.paddingRight),
    };
    // The line's own box hugs its text; its grid cell is what takes the row's free width.
    const cell = line?.parentElement?.getBoundingClientRect();
    return {
      pillVisible: shown,
      gap: box && scroller ? Math.round(scroller.getBoundingClientRect().bottom - box.bottom) : null,
      pill: box && { top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), right: Math.round(box.right) },
      line: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) } : null,
      row: row && { left: Math.round(row.left), right: Math.round(row.right) },
      cell: cell && { left: Math.round(cell.left), right: Math.round(cell.right) },
    };
  })()`;
  type Geometry = {
    pillVisible: boolean;
    gap: number | null;
    pill: { top: number; bottom: number; left: number; right: number } | null;
    line: { top: number; bottom: number; left: number; right: number } | null;
    row: { left: number; right: number } | null;
    cell: { left: number; right: number } | null;
  };

  await until(`(() => {
    const scroller = ${history};
    if (scroller) scroller.scrollTop = 0;
    return Boolean(${pill}?.checkVisibility());
  })()`);

  const alone = await evaluate<Geometry>(geometry);
  expect(alone.pillVisible).toBe(true);
  expect(alone.gap).toBeGreaterThanOrEqual(0);
  expect(alone.gap).toBeLessThanOrEqual(24);
  await fx.screenshot("pill-alone.png");

  const call = await announce(`#${name}`);
  try {
    await until(visible(typingSentence));
    // The line eases in from 0.25rem lower (replying-agents-line.css); measure it where it lands.
    await until(`[...document.querySelectorAll(".replying-line")].some(
      (node) => node.textContent === ${JSON.stringify(typingSentence)} &&
        node.getAnimations().every((animation) => animation.playState === "finished"),
    )`);
    const withLine = await evaluate<Geometry>(geometry);
    expect(withLine.line).not.toBeNull();
    expect(withLine.gap).toBe(alone.gap!);
    expect(withLine.pill).toEqual(alone.pill!);
    const line = withLine.line!;
    const jump = withLine.pill!;
    const apart =
      line.right <= jump.left ||
      jump.right <= line.left ||
      line.bottom <= jump.top ||
      jump.bottom <= line.top;
    expect(apart).toBe(true);
    await fx.screenshot("pill-with-line.png");

    await browser("eval", `${pill}.click()`);
    await until(`!(${pill}?.checkVisibility())`);
    const landed = await evaluate<Geometry>(geometry);
    expect(landed.pillVisible).toBe(false);
    expect(landed.line).toEqual(line);
    const row = landed.row!;
    const cell = landed.cell!;
    expect(cell.left - row.left).toBeLessThanOrEqual(24);
    expect(row.right - cell.right).toBeLessThanOrEqual(24);
    await fx.screenshot("pill-gone-line-kept.png");
  } finally {
    await call.end();
  }
}, 180_000);

test("with Live agent activity off neither line shows", async () => {
  await open(fx.joinedId);
  await untilText(`Thread root ${suffix}`);
  await browser("eval", `localStorage.setItem("coforge-live-agent-activity", "hide")`);
  await open(fx.joinedId);
  await untilText(`Thread root ${suffix}`);

  const thread = await announce(`#e2e-replying-${suffix}:${fx.rootId}`);
  const top = await announce(`#e2e-replying-${suffix}`);
  try {
    const either = `${visible(replyingSentence)} || ${visible(typingSentence)}`;
    await staysFalse(either, 4_000);
    await fx.screenshot("live-activity-off.png");

    // Control: with the device flag back on, the same live intents show, so the silence above
    // was the preference and not a lost frame.
    await browser("eval", `localStorage.removeItem("coforge-live-agent-activity")`);
    await open(fx.joinedId);
    await until(visible(replyingSentence), 60_000);
    await until(visible(typingSentence));
    await fx.screenshot("live-activity-on.png");
  } finally {
    thread.stop();
    top.stop();
  }
}, 180_000);

test("a reply that lands before the start of its call keeps that call from showing", async () => {
  await fx.open(fx.joinedId);
  await fx.untilText(`Thread root ${suffix}`);
  const target = `#${fx.joinedName}:${fx.rootId}`;

  const reply = `Early reply ${suffix}`;
  const preview = `[data-message-id="${fx.rootId}"] [data-thread-preview]`;
  await agentSends(target, reply);
  await until(
    `document.querySelector(${JSON.stringify(preview)})?.textContent.includes(${JSON.stringify(reply)}) === true`,
  );
  const late = await announce(target);
  try {
    await staysFalse(visible(replyingSentence), 10_000);
    await fx.screenshot("start-after-reply.png");
  } finally {
    late.stop();
  }

  // Control, more than 8s after the reply: a fresh call does show, so the silence above came from
  // the claim and not from a broken setup.
  const fresh = await announce(target);
  try {
    await until(visible(replyingSentence));
    await fx.screenshot("fresh-call-shows.png");
  } finally {
    await fresh.end();
  }
  await until(`!(${visible(replyingSentence)})`);
}, 180_000);

test("a reply in a thread whose root is not loaded still ends its intent before the root is shown", async () => {
  const name = `e2e-window-${suffix}`;
  const channelId = await fx.createChannel(name);
  const old = await fx.send(channelId, DEV_BROWSER_USER.id, `Old root ${suffix}`);
  // Enough top-level messages after the root that opening the channel at its newest does not load
  // the root: a window page holds 20, and the pane loads older pages while its top is within a
  // screenful and 600px of view (`OlderMessagesRow`, task #171), so a few pages of short messages
  // load at once.
  for (let n = 1; n <= 100; n += 1)
    await fx.send(channelId, DEV_BROWSER_USER.id, `Newer message ${n} of ${suffix}`);

  await fx.open(channelId);
  await fx.untilText(`Newer message 100 of ${suffix}`);
  expect(await evaluate<boolean>(`document.body.innerText.includes("Old root ${suffix}")`)).toBe(
    false,
  );

  const target = `#${name}:${old.id}`;
  const call = await announce(target);
  try {
    await Bun.sleep(1_500);
    await agentSends(target, `Reply under the old root ${suffix}`);
    // Let the reply reach the cache and a few more starts repeat, then jump to the root without
    // reloading the page: a reload would drop the in-memory intents and make this test vacuous.
    await Bun.sleep(7_000);
    await evaluate<boolean>(`(() => {
      window.__noReload = true;
      history.pushState(null, "", ${JSON.stringify(`${fx.workspacePath}/channel/${channelId}?message=${old.id}`)});
      dispatchEvent(new PopStateEvent("popstate"));
      return true;
    })()`);
    await fx.untilText(`Old root ${suffix}`);
    // Same page, same realtime-fed cache: no reload happened.
    expect(await evaluate<boolean>(`window.__noReload === true`)).toBe(true);
    await staysFalse(visible(replyingSentence), 7_000);
    await fx.screenshot("old-root-after-jump.png");
  } finally {
    call.stop();
  }
  // Without the fix the intent is only ended by the view showing the thread's root, which was not
  // loaded when the reply arrived, so the repeating start would still be live and "is replying"
  // would show under the root as soon as it renders.
}, 240_000);
