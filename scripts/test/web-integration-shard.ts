const measuredMilliseconds = new Map<string, number>([
  ["apps/web/test/activity-inbox-page-plan.integration.test.ts", 6117],
  ["apps/web/test/activity-nav-attention-plan.integration.test.ts", 4940],
  ["apps/web/test/agent-inbox-list.integration.ts", 9311],
  ["apps/web/test/app-notification-presence.integration.ts", 4346],
  ["apps/web/test/app-notifications-dark.integration.test.ts", 25083],
  ["apps/web/test/app-notifications.integration.test.ts", 7257],
  ["apps/web/test/app-webhook-delivery-queue.integration.test.ts", 10740],
  ["apps/web/test/attachment-comment-migration-cli.integration.ts", 5092],
  ["apps/web/test/attachment-comment-rehearsal.integration.ts", 9609],
  ["apps/web/test/channel-coordinator.integration.test.ts", 3123],
  ["apps/web/test/channel-mention-affinity-plan.integration.test.ts", 4994],
  ["apps/web/test/channel-sidebar-thread-unread.integration.ts", 3844],
  ["apps/web/test/database-pool.integration.test.ts", 11124],
  ["apps/web/test/mention-delivery.integration.test.ts", 7151],
  ["apps/web/test/message-search-plan.integration.test.ts", 6556],
  ["apps/web/test/production.integration.ts", 8169],
  ["apps/web/test/redis-client-reconnect.integration.ts", 39948],
  ["apps/web/test/server-lifecycle.integration.ts", 6563],
  ["apps/web/test/statement-pool.integration.test.ts", 3672],
  ["apps/web/test/subscribe-proxy.integration.ts", 57601],
  ["apps/web/test/task-assignment-authority.integration.ts", 8719],
  ["apps/web/test/task-dependencies.integration.ts", 4754],
  ["apps/web/test/task-dependency-notices.integration.ts", 4425],
  ["apps/web/test/task-done-owner.integration.ts", 4105],
  ["apps/web/test/task-idle-reminder.integration.ts", 5237],
  ["apps/web/test/task-overview.integration.ts", 3036],
  ["apps/web/test/workspace-delete.integration.test.ts", 3286],
  ["scripts/migration-safety/lock-timeout.integration.ts", 25044],
]);
const defaultMilliseconds = 590;
const importedSuiteByFile = new Map([
  ["apps/web/test/agent-events.integration.ts", "apps/web/test/agent-events-drain.integration.ts"],
  [
    "apps/web/test/public-channel-mute.integration.ts",
    "apps/web/test/channel-reference-agent-reads.integration.ts",
  ],
]);

const [shardArgument, ...files] = Bun.argv.slice(2);
const shard = Number(shardArgument);
const loads = [0, 0, 0, 0];
const selected = new Set<string>();
const groups = new Map<string, string[]>();
for (const file of files) {
  const key = importedSuiteByFile.get(file) ?? file;
  const group = groups.get(key) ?? [];
  group.push(file);
  groups.set(key, group);
}

const ranked = [...groups]
  .map(([key, files]) => ({
    key,
    files,
    milliseconds: files.reduce(
      (sum, file) => sum + (measuredMilliseconds.get(file) ?? defaultMilliseconds),
      0,
    ),
  }))
  .sort(
    (left, right) =>
      right.milliseconds - left.milliseconds ||
      Number(left.key > right.key) - Number(left.key < right.key),
  );

for (const { files, milliseconds } of ranked) {
  const index = loads.indexOf(Math.min(...loads));
  loads[index]! += milliseconds;
  if (index + 1 === shard) {
    for (const file of files) selected.add(file);
  }
}

for (const file of files) {
  if (selected.has(file)) console.log(file);
}
