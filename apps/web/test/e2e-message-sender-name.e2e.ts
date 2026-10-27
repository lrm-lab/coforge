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
/** Narrows the first row naming `name` until it has 20px left for the model beside a whole name and
 * the time, then reports whether the name lost any of its width (a fraction of a pixel already
 * shows its ellipsis, which `scrollWidth` rounds away) and how wide the model still is. */
const squeezeBesideModel = (name: string) => `(() => {
  const text = [...document.querySelectorAll("main p [data-text]")].find((node) => node.textContent === ${JSON.stringify(name)});
  const row = text.closest("p");
  const range = document.createRange();
  range.selectNodeContents(text);
  const whole = range.getBoundingClientRect().width;
  const time = row.querySelector("time").getBoundingClientRect().width;
  row.style.width = (whole + time + 2 * 8 + 32 + 20) + "px";
  const cut = range.getBoundingClientRect().width > text.getBoundingClientRect().width + 0.01;
  const model = row.firstElementChild.lastElementChild.getBoundingClientRect().width;
  row.style.width = "";
  return { cut, model: Math.round(model) };
})()`;
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

  // With room for the whole name but not the model too, the model gives way and the name keeps
  // every letter: no ellipsis beside a model still showing ("leagent-o…  gemini-…").
  const squeezed = await evaluate<{ cut: boolean; model: number }>(squeezeBesideModel(name));
  expect(squeezed.cut).toBe(false);
  expect(squeezed.model).toBeGreaterThan(0);

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
