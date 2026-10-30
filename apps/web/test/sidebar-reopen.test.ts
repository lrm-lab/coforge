import { expect, test } from "bun:test";

import { sidebarWith } from "./helpers/sidebar-fake";

/** Opening a closed chat brings it back to the sidebar (`useReopenClosedOnOpen`), against fake
 * server calls. */
test("a closed chat the viewer opens again shows at once in the list and is saved", async () => {
  const { sidebar, saves } = await sidebarWith();
  await sidebar.actions.close({ kind: "direct", conversationId: "dm-grace" });
  await sidebar.actions.close({ kind: "channel", channelId: "random" });
  const dm = sidebar.actions.reopen({ kind: "direct", conversationId: "dm-grace" });
  const channel = sidebar.actions.reopen({ kind: "channel", channelId: "random" });
  expect(sidebar.directs.get("dm-grace")?.hidden).toBe(false);
  expect(sidebar.channels.get("random")?.hidden).toBe(false);
  await Promise.all([dm, channel]);
  expect(saves.slice(2)).toEqual([
    `reopen {"kind":"direct","conversationId":"dm-grace"}`,
    `reopen {"kind":"channel","channelId":"random"}`,
  ]);
});

test("a closed channel the list does not hold is reopened on the server", async () => {
  const { sidebar, saves } = await sidebarWith();
  await sidebar.actions.reopen({ kind: "channel", channelId: "closed-elsewhere" });
  expect(saves).toEqual([`reopen {"kind":"channel","channelId":"closed-elsewhere"}`]);
});
