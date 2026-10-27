import { expect, test } from "bun:test";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

/**
 * Browser E2E (task #223): a message's sender name keeps its first letters in a narrow pane. The
 * thread pane is about 320px, so an Agent with a long name and a model label used to lose the name's
 * start to its centred, clipped button ("eagent-ops"). The model label gives way first, then the
 * name, which ends in an ellipsis; the time stays in the row. Opt-in like the
 * other browser E2Es; see `helpers/agent-replying-fixture.ts`. Screenshots are written under
 * `.amp/e2e/message-sender-name/`.
 */
const fx = setupAgentReplying({ artifactsName: "message-sender-name" });
const { suffix, db, evaluate, until } = fx;

/** For each row naming `name`: whether the name's text starts inside its own box, ends in an ellipsis
 * when cut, and leaves the time inside the row. */
const nameBoxes = (name: string) => `(() => [...document.querySelectorAll("[data-text]")]
  .filter((text) => text.textContent === ${JSON.stringify(name)})
  .map((text) => {
    const box = text.parentElement.getBoundingClientRect();
    const own = text.getBoundingClientRect();
    const row = text.closest("p").getBoundingClientRect();
    const time = text.closest("p").querySelector("time").getBoundingClientRect();
    return { timeInside: time.right <= row.right + 0.5, startClipped: own.left < box.left - 0.5, ellipsis: getComputedStyle(text).textOverflow === "ellipsis", overflows: text.scrollWidth > text.clientWidth };
  }))()`;
type NameBox = {
  timeInside: boolean;
  startClipped: boolean;
  ellipsis: boolean;
  overflows: boolean;
};

test("a long sender name in the thread pane keeps its first letters", async () => {
  const name = `leagent-ops-${suffix}`;
  await db.agent.update({ where: { id: fx.agentId }, data: { displayName: name } });
  await fx.agentSends(`#${fx.joinedName}:${fx.rootId}`, `Reply from a long name ${suffix}`);

  await fx.open(fx.joinedId, `?threadRootId=${fx.rootId}`);
  await fx.untilText(`Reply from a long name ${suffix}`);
  await until(`${nameBoxes(name)}.length > 0`);
  const boxes = await evaluate<NameBox[]>(nameBoxes(name));
  for (const box of boxes) {
    expect(box.startClipped).toBe(false);
    expect(box.timeInside).toBe(true);
    // Only a name that alone outgrows its row may be cut, and then at its end.
    if (box.overflows) expect(box.ellipsis).toBe(true);
  }
  await fx.screenshot("thread-pane.png");

  // A name longer than the whole row ends in an ellipsis rather than losing its start. Another
  // Agent posts it, so its row has a header of its own.
  const other = fx.otherAgents[0]!;
  const long = `${name}-${"x".repeat(60)}`;
  await db.agent.update({ where: { id: other.id }, data: { displayName: long } });
  const sender = fx.agentId;
  fx.agentId = other.id;
  try {
    await fx.agentSends(`#${fx.joinedName}:${fx.rootId}`, `Reply from a longer name ${suffix}`);
  } finally {
    fx.agentId = sender;
  }
  await fx.untilText(`Reply from a longer name ${suffix}`);
  await until(`${nameBoxes(long)}.length > 0`);
  const longBoxes = await evaluate<NameBox[]>(nameBoxes(long));
  expect(longBoxes.some((box) => box.overflows)).toBe(true);
  for (const box of longBoxes) {
    expect(box.startClipped).toBe(false);
    expect(box.timeInside).toBe(true);
    if (box.overflows) expect(box.ellipsis).toBe(true);
  }
  await fx.screenshot("thread-pane-long.png");
}, 240_000);
