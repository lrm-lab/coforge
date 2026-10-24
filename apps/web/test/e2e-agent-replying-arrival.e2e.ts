import { expect, test } from "bun:test";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { setupAgentReplying, visible } from "./helpers/agent-replying-fixture";

/**
 * A reply intent ends where the Agent's message arrives in the browser's cache, not where it is
 * shown (`useConversationQuery`'s `mergeUpdates` tells the reply-intent store). Two consequences:
 *
 * - A reply that lands before its call's start claims the next new start of that Agent in that
 *   place within 8s, so a late-arriving start (and its repeats) is never shown.
 * - A reply to a thread whose root is outside the loaded window still ends the intent, so jumping
 *   to that root afterwards does not show "<Agent> is replying" under it.
 *
 * Shared setup and screenshots (`.amp/e2e/agent-replying-arrival/`): `helpers/agent-replying-fixture.ts`.
 */
const fx = setupAgentReplying({ artifactsName: "agent-replying-arrival" });
const { suffix, replyingSentence, evaluate, until, staysFalse, announce, agentSends } = fx;

test("a reply that lands before the start of its call keeps that call from showing", async () => {
  await fx.open(fx.joinedId);
  await fx.untilText(`Thread root ${suffix}`);
  const target = `#${fx.joinedName}:${fx.rootId}`;

  // The reply is first; the start of the call arrives after it and repeats every 5s.
  await agentSends(target, `Early reply ${suffix}`);
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
  // More top-level messages after the root than a window page holds (20), so opening the channel
  // at its newest does not load the root.
  for (let n = 1; n <= 30; n += 1)
    await fx.send(channelId, DEV_BROWSER_USER.id, `Newer message ${n} of ${suffix}`);

  await fx.open(channelId);
  await fx.untilText(`Newer message 30 of ${suffix}`);
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
