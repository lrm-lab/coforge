type InboxEntry = {
  kind?: string;
  messageTarget?: {
    target?: string;
    pendingCount?: number;
    latestSenderHandle?: string;
    flags?: string[];
  };
  app?: { title?: string; summary?: string; itemId?: string };
};

export function formatInboxCheck(result: unknown, json = false): string {
  if (!result || typeof result !== "object") return JSON.stringify(result);
  const response = result as { entries?: unknown[]; [key: string]: unknown };
  const entries = (response.entries ?? []) as InboxEntry[];
  if (json)
    return JSON.stringify({
      ...response,
      ...(response.entries
        ? {
            entries: entries.map((entry) => {
              if (!entry?.messageTarget) return entry;
              const {
                firstPendingSequence: _first,
                latestSequence: _latest,
                ...messageTarget
              } = entry.messageTarget as typeof entry.messageTarget & Record<string, unknown>;
              return { ...entry, messageTarget };
            }),
          }
        : {}),
    });
  const targets = entries.flatMap((entry) => (entry.messageTarget ? [entry.messageTarget] : []));
  const apps = entries.flatMap((entry) => (entry.kind === "app" && entry.app ? [entry.app] : []));
  const dms = targets.filter((target) => target.target?.startsWith("@")).length;
  const mentions = targets.filter((target) => target.flags?.includes("non_member_mention")).length;
  const lines = [
    `Inbox: ${targets.length} unread conversation(s) (${dms} DMs, ${mentions} with mentions).`,
  ];
  for (const target of targets) {
    const name = target.target ?? "<unknown target>";
    const mention = target.flags?.includes("non_member_mention") ? " · mentions you" : "";
    const sender = target.latestSenderHandle ? `@${target.latestSenderHandle}` : "unknown sender";
    lines.push(`${name} · ${target.pendingCount ?? 0} unread${mention} · latest ${sender}`);
    lines.push(`open: coforge message read --target ${JSON.stringify(name)}`);
  }
  if (apps.length > 0) {
    lines.push("", `App items pending: ${apps.length}.`);
    for (const app of apps)
      lines.push(`- ${app.title ?? app.itemId ?? "App item"}: ${app.summary ?? ""}`.trimEnd());
  }
  if (targets[0]?.target)
    lines.push("", `Next: coforge message read --target ${JSON.stringify(targets[0].target)}`);
  return lines.join("\n");
}
