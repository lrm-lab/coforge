import { expect, test } from "bun:test";
import { setupAgentReplying, visible } from "./helpers/agent-replying-fixture";

/**
 * Browser E2E (task #210): the line under a thread's root and the pill above the composer are one
 * component. Both draw the same face group, at most three overlapping mascots, and the same
 * sentence rules, with only the verb differing. Opt-in like the other browser E2Es; see
 * `helpers/agent-replying-fixture.ts`. Screenshots are written under
 * `.amp/e2e/agent-replying-group/`.
 */
const fx = setupAgentReplying({ artifactsName: "agent-replying-group" });
const { suffix, agentName, evaluate, until } = fx;

/** How many faces the line showing `sentence` draws. */
const faces = (sentence: string) =>
  `[...document.querySelectorAll(".replying-line")].find((line) => line.textContent === ${JSON.stringify(sentence)})?.querySelector('[aria-hidden="true"]').children.length ?? -1`;

test("one, three and four Agents read the same under a root and above the composer", async () => {
  const [b, c] = fx.otherAgents.map((agent) => agent.name);
  const thread = `#e2e-replying-${suffix}:${fx.rootId}`;
  const calls: { stop: () => void }[] = [];
  // Agents start one after another so the sentence lists them in that order.
  const announceAll = async (target: string, ids: string[]) => {
    for (const id of ids) calls.push(await fx.announce(target, id));
  };
  try {
    // Under the root, in the channel's stream.
    await fx.open(fx.joinedId);
    await fx.untilText(`Thread root ${suffix}`);
    await announceAll(thread, [fx.agentId]);
    await until(visible(`${agentName} is replying`));
    expect(await evaluate<number>(faces(`${agentName} is replying`))).toBe(1);
    await fx.screenshot("root-one.png");
    await announceAll(
      thread,
      fx.otherAgents.slice(0, 2).map((agent) => agent.id),
    );
    await until(visible(`${agentName}, ${b} and ${c} are replying`));
    expect(await evaluate<number>(faces(`${agentName}, ${b} and ${c} are replying`))).toBe(3);
    await fx.screenshot("root-three.png");
    await announceAll(thread, [fx.otherAgents[2]!.id]);
    const overflow = `${agentName}, ${b} and 2 other agents are replying`;
    await until(visible(overflow));
    expect(await evaluate<number>(faces(overflow))).toBe(3);
    await fx.screenshot("root-four.png");

    // The same Agents in the open thread: the pill above its composer.
    await fx.open(fx.joinedId, `?threadRootId=${fx.rootId}`);
    const typing = `${agentName}, ${b} and 2 other agents are typing…`;
    await until(visible(typing));
    expect(await evaluate<number>(faces(typing))).toBe(3);
    await fx.screenshot("thread-four.png");
  } finally {
    for (const call of calls) call.stop();
  }

  // One Agent typing in the channel itself.
  const main = await fx.announce(`#e2e-replying-${suffix}`);
  try {
    await fx.open(fx.joinedId);
    await until(visible(`${agentName} is typing…`));
    expect(await evaluate<number>(faces(`${agentName} is typing…`))).toBe(1);
    await fx.screenshot("main-one.png");
  } finally {
    main.stop();
  }
}, 240_000);
