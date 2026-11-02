import { expect, test } from "bun:test";
import type { SystemNotice } from "#src/features/conversations/system-notice";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

/**
 * Browser E2E (task #185): a system notice reads in the viewer's language, rendered from its
 * stored kind and params, in the stream (a folded run and a lone notice) and in the channel's
 * sidebar preview; the stored English body is what the Agent API reads. Opt-in like the other
 * browser E2Es; see `helpers/agent-replying-fixture.ts`. Screenshots are written under
 * `.amp/e2e/system-notice-language/`.
 */
const fx = setupAgentReplying({ artifactsName: "system-notice-language" });
const { suffix, evaluate, until } = fx;

const frank = { memberId: null, handle: "frank-an", displayName: "Frank An" };
const coder = { memberId: null, handle: "coder", displayName: "Coder" };
const task = (number: number, title: string) => ({ taskId: crypto.randomUUID(), number, title });

/** A server notice in the channel: the English body the server writes, and its kind and params. */
async function notice(conversationId: string, body: string, system: SystemNotice) {
  await fx.db.$transaction(async (tx) => {
    const sequence = await allocateSequence(tx, conversationId);
    const message = await tx.message.create({
      data: { workspaceId: fx.workspaceId, conversationId, senderMemberId: null, sequence, body },
    });
    await tx.systemMessage.create({
      data: {
        messageId: message.id,
        conversationId,
        workspaceId: fx.workspaceId,
        kind: system.kind,
        params: system.params,
      },
    });
  });
}

test("notices read in Chinese in the stream and the sidebar, and in English under /", async () => {
  const name = `e2e-notices-${suffix}`;
  const channelId = await fx.createChannel(name);
  const fix = task(4, "修复登录");
  await fx.send(channelId, DEV_BROWSER_USER.id, `Notices ${suffix}`);
  await notice(channelId, '📋 2 new tasks created: #4 "修复登录", #5 "Ship it"', {
    kind: "task.created",
    params: { tasks: [fix, task(5, "Ship it")] },
  });
  await notice(channelId, '📌 frank-an assigned #4 "修复登录" to @coder', {
    kind: "task.assigned",
    params: { actor: frank, task: fix, assignee: coder },
  });
  await notice(channelId, '📌 coder claimed #4 "修复登录"', {
    kind: "task.claimed",
    params: { claimer: coder, task: fix },
  });
  await notice(channelId, '🔄 coder moved #4 "修复登录" to In Progress', {
    kind: "task.moved",
    params: { actor: coder, task: fix, status: "in_progress" },
  });
  await fx.send(channelId, DEV_BROWSER_USER.id, `Between ${suffix}`);
  await notice(channelId, "Frank An made @coder the coordinator of #team", {
    kind: "channel.coordinator_changed",
    params: { channelId: channelId, channelName: name, actor: frank, next: coder },
  });

  const zh = fx.workspacePath.replace(/^\/en\//, "/zh-CN/");
  await fx.browser("open", `${fx.proxy.origin}${zh}/channel/${channelId}`);
  await until(`document.body.innerText.includes("设为 #${name} 的协调员")`, 60_000);
  await fx.screenshot("zh-stream-folded.png");
  // The folded run names its four notices as task updates.
  expect(await evaluate<string>("document.body.innerText")).not.toContain("new tasks created");

  await evaluate(
    `[...document.querySelectorAll("button")].find((b) => /任务更新/.test(b.textContent ?? ""))?.click()`,
  );
  await until(`document.body.innerText.includes("把任务 #4「修复登录」指派给了 @coder")`, 10_000);
  await fx.screenshot("zh-stream-expanded.png");
  const text = await evaluate<string>("document.body.innerText");
  expect(text).toContain("📋 新建了 2 个任务：#4「修复登录」、#5「Ship it」");
  expect(text).toContain("🔄 Coder 把任务 #4「修复登录」移到了进行中");
  // The sidebar row's preview is the latest notice, in Chinese too.
  expect(text).toContain(`Frank An 把 @coder 设为 #${name} 的协调员`);

  await fx.open(channelId);
  await until(`document.body.innerText.includes("Frank An made @coder the coordinator")`, 60_000);
  await fx.screenshot("en-stream.png");
}, 240_000);
