import { useEffect, useState } from "react";
import { Link, useHydrated } from "@tanstack/react-router";
import { SearchLg } from "@untitledui/icons";
import type { PiChatSession } from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useTimeZone } from "#src/lib/time-zone-context";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export function PiChatSessionList({
  sessions,
  search,
  workspaceSlug,
  computerId,
  sessionId,
  clearSearch,
}: {
  sessions: PiChatSession[];
  search: string;
  workspaceSlug: string;
  computerId: string;
  sessionId?: string;
  clearSearch(): void;
}) {
  const hydrated = useHydrated();
  const zone = useTimeZone();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const today = hydrated
    ? Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone).toPlainDate()
    : undefined;
  const labels = [
    m.pi_chat_today(),
    m.pi_chat_yesterday(),
    m.pi_chat_last_week(),
    m.pi_chat_earlier(),
  ];
  const groups = labels.map(() => [] as PiChatSession[]);
  const query = search.trim().toLocaleLowerCase();
  for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!session.title.toLocaleLowerCase().includes(query)) continue;
    const date = today
      ? Temporal.Instant.fromEpochMilliseconds(session.updatedAt)
          .toZonedDateTimeISO(zone)
          .toPlainDate()
      : undefined;
    const days = today && date ? date.until(today).days : 0;
    const group = days <= 0 ? 0 : days === 1 ? 1 : days < 7 ? 2 : 3;
    groups[group]!.push(session);
  }
  if (!groups.some((group) => group.length))
    return (
      <div className="space-y-2 px-3 py-6 text-sm text-tertiary">
        <SearchLg aria-hidden="true" className="mb-3 size-5" />
        <p>{query ? m.pi_chat_no_matches() : m.pi_chat_no_sessions()}</p>
        {query && (
          <Button color="link-gray" size="sm" onClick={clearSearch}>
            {m.pi_chat_clear_search()}
          </Button>
        )}
      </div>
    );
  return groups.map((group, index) =>
    group.length ? (
      <section key={labels[index]} aria-label={labels[index]} className="mb-4">
        {hydrated && (
          <h2 className="px-3 py-2 text-xs font-medium text-tertiary">{labels[index]}</h2>
        )}
        {group.map((session) => (
          <Link
            key={session.id}
            to="/w/$workspaceSlug/pi-chat"
            params={{ workspaceSlug }}
            search={{ computer: computerId, session: session.id }}
            aria-current={sessionId === session.id ? "page" : undefined}
            className={cn(
              "mb-1 block rounded-lg px-3 py-2 text-sm text-primary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2",
              sessionId === session.id && "bg-active",
            )}
          >
            <p className="truncate font-medium">{session.title}</p>
            <div className="mt-1 flex items-center gap-2 text-xs text-tertiary">
              {session.status === "running" ? (
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-brand-solid" />
                  {m.pi_chat_running()}
                </span>
              ) : (
                <RelativeTime value={new Date(session.updatedAt)} timeZone={zone} plain />
              )}
              {session.status === "error" && (
                <span className="text-error-primary">{m.pi_chat_tool_failed()}</span>
              )}
              {session.status === "interrupted" && <span>{m.pi_chat_session_interrupted()}</span>}
              {session.status === "stopped" && <span>{m.pi_chat_stopped()}</span>}
            </div>
          </Link>
        ))}
      </section>
    ) : null,
  );
}
