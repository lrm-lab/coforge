import { expect, test } from "bun:test";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

/**
 * A mention that arrives while the reader is in another channel (task #coforge-designer-team:#135):
 * the sidebar row of the channel that mentions them takes the "@" badge without a reload, and the
 * badge is gone once they open that channel. The mention travels the real path — an Agent of the
 * channel sends it through the Agent API's send handler, so the row is updated by the app's own
 * realtime fan-out — and the assertions read the row itself, not the server state.
 *
 * Opt-in like the other browser E2Es (`scripts/e2e` starts the stack it needs). Each run seeds its
 * own channels, Agent, Computer and member through the shared fixture and removes them afterwards.
 * Screenshots are written under `.artifacts/e2e/sidebar-mention-badge/`.
 */
const fx = setupAgentReplying({ artifactsName: "sidebar-mention-badge" });
const { suffix, open, until, untilText, evaluate, agentSends } = fx;

const rowOf = (conversationId: string) =>
  `document.querySelector('a[href*="/channel/${conversationId}"]')`;
const mentionMark = (conversationId: string) => `(() => {
  const link = ${rowOf(conversationId)};
  if (!link) return null;
  const badge = [...link.querySelectorAll("span")].find((span) =>
    typeof span.className === "string" && span.className.includes("bg-unread-capsule-muted"),
  );
  return { shown: Boolean(badge) && badge.getClientRects().length > 0 };
})()`;

test("a mention in another channel puts the @ badge on its sidebar row until that channel is opened", async () => {
  const mentionedName = `e2e-mentioned-${suffix}`;
  const mentioned = await fx.createChannel(mentionedName);
  await open(fx.joinedId);
  await untilText(`Thread root ${suffix}`);
  await until(`(${mentionMark(mentioned)})?.shown === false`, 30_000);

  await agentSends(`#${mentionedName}`, `<@human:${DEV_BROWSER_USER.id}> look at this ${suffix}`);
  const rowState = await evaluate(`(() => {
  const link = ${rowOf(mentioned)};
  if (!link) return { found: false };
  const capsules = [...link.querySelectorAll("span")].filter((span) =>
    typeof span.className === "string" && span.className.includes("rounded-full"),
  ).length;
  return { found: true, label: link.getAttribute("aria-label"), capsules };
})()`);
  console.log("row state after the mention:", JSON.stringify(rowState));
  const dbName = (Bun.env.DATABASE_URL ?? "").split("/").pop() ?? "";
  const mentionRows =
    await Bun.$`docker exec coforge-e2e-postgres-1 psql -U coforge -d ${dbName} -tAc "select count(*) from message_mentions"`
      .text()
      .catch(() => "unreadable");
  console.log("message_mentions rows:", mentionRows.trim());
  await until(`(${mentionMark(mentioned)})?.shown === true`, 60_000);
  await fx.screenshot("mention-badge.png");

  await open(mentioned);
  await until(`(${mentionMark(mentioned)})?.shown === false`, 60_000);
  await fx.screenshot("mention-badge-cleared.png");

  expect(await evaluate(`Boolean(${rowOf(mentioned)})`)).toBe(true);
}, 180_000);
