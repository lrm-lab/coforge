import { expect, test } from "bun:test";
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
 * Screenshots are written under `.amp/e2e/agent-replying/`. The setup is shared in `helpers/agent-replying-fixture.ts`.
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

test("on a phone the typing line shares the composer's top edge with the jump group", async () => {
  await browser("set", "viewport", "393", "852");
  try {
    await open(fx.joinedId);
    await untilText(`Thread root ${suffix}`);
    const call = await announce(`#e2e-replying-${suffix}`);
    try {
      await until(visible(typingSentence));
      // The dev user's own root puts the jump group on the line's row, and the sentence ends
      // before the group starts: neither covers the other.
      const gap = await evaluate<number | null>(`(() => {
        const line = [...document.querySelectorAll('[role="status"]')]
          .find((node) => node.textContent === ${JSON.stringify(typingSentence)})
          .closest(".replying-line");
        const group = line.closest(':has([role="group"])')?.querySelector('[role="group"]');
        return group && group.getBoundingClientRect().left - line.getBoundingClientRect().right;
      })()`);
      expect(gap).not.toBeNull();
      expect(gap!).toBeGreaterThanOrEqual(0);
      await fx.screenshot("typing-phone.png");
    } finally {
      await call.end();
    }
  } finally {
    await browser("set", "viewport", "1440", "900");
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
