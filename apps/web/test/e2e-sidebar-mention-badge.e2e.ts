import { expect, test } from "bun:test";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

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

  await agentSends(`#${mentionedName}`, `@dev-user look at this ${suffix}`);
  await until(`(${mentionMark(mentioned)})?.shown === true`, 60_000);
  await fx.screenshot("mention-badge.png");

  await open(mentioned);
  await until(`(${mentionMark(mentioned)})?.shown === false`, 60_000);
  await fx.screenshot("mention-badge-cleared.png");

  expect(await evaluate(`Boolean(${rowOf(mentioned)})`)).toBe(true);
}, 180_000);
