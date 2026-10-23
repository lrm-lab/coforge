import { useEffect, useEffectEvent, useMemo, useState } from "react";

import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

import { AgentMascotView } from "./agent-mascot-view";
import { AvatarSticker } from "#src/features/avatars/avatar-sticker";
import { busyAgentsAmong, summarizeBusyAgents, type BusyAgent } from "./busy-agents-summary";
import { useLiveAgents } from "./workspace-agents-realtime";
import "./busy-agents-strip.css";

/** How long one busy Agent's avatar stays before the next one takes its place. */
const AVATAR_CYCLE_MS = 4000;

type Shown = {
  /** Which busy Agent is on show; it wraps, so a busy list that shrinks needs no repair. */
  at: number;
  /** The Agent handing over: its still picture fades out while the new mascot fades in. */
  leaving?: BusyAgent;
};

/**
 * One 24px avatar showing the busy Agents' mascots in turn, each acting out its own work, as
 * stickers. It is decorative: the line beside it names the Agents, so a switch announces nothing.
 */
function BusyAvatar({ agents }: { agents: readonly BusyAgent[] }) {
  const reducedMotion = usePrefersReducedMotion();
  const [shown, setShown] = useState<Shown>({ at: 0 });
  const current = agents[shown.at % agents.length];
  const advance = useEffectEvent(() =>
    setShown({ at: (shown.at + 1) % agents.length, leaving: current }),
  );
  const cycling = agents.length > 1 && !reducedMotion;
  useEffect(() => {
    if (!cycling) return;
    const timer = setInterval(advance, AVATAR_CYCLE_MS);
    return () => clearInterval(timer);
  }, [cycling]);
  if (!current) return null;
  const leaving = cycling && shown.leaving?.id !== current.id ? shown.leaving : undefined;
  return (
    <span aria-hidden="true" className="flex shrink-0">
      <AvatarSticker size="xs">
        {leaving && (
          <span
            key={leaving.id}
            className="busy-avatar-out absolute inset-0"
            onAnimationEnd={() => setShown((previous) => ({ ...previous, leaving: undefined }))}
          >
            <AgentMascotView mascot={leaving.mascot} activity={leaving.activity} still />
          </span>
        )}
        <span
          key={current.id}
          className={`absolute inset-0 ${reducedMotion ? "" : "busy-avatar-in"}`}
        >
          <AgentMascotView mascot={current.mascot} activity={current.activity} />
        </span>
      </AvatarSticker>
    </span>
  );
}

/**
 * A line above a conversation's composer saying which of its Agents are busy right now, and with
 * what ("Atlas and Sam running command · Kai thinking"). `agentIds` are the conversation's Agent
 * members; it reads their live display like every other Agent surface and renders nothing while
 * none is working or thinking. The text is plain, not a live region: tool labels change often.
 */
export function BusyAgentsStrip({ agentIds }: { agentIds: readonly string[] }) {
  const agents = useLiveAgents();
  // Keyed on the ids themselves, so a caller may pass a fresh array every render.
  const idKey = agentIds.join(",");
  const memberIds = useMemo(() => (idKey ? idKey.split(",") : []), [idKey]);
  const busy = useMemo(() => busyAgentsAmong(agents, memberIds), [agents, memberIds]);
  if (busy.length === 0) return null;
  // The wording comes from the messages and locale at render, so a locale change shows at once.
  const parts = summarizeBusyAgents(busy, {
    locale: getLocale(),
    others: (count) => m.agent_busy_others({ count }),
  });
  return (
    <div className="mx-4 mt-2 -mb-1 flex min-h-6 items-center gap-2 px-1 text-xs md:mx-6">
      <BusyAvatar agents={busy} />
      <p className="min-w-0 truncate text-tertiary">
        {parts.map((part, index) => (
          <span
            key={index}
            className={part.kind === "name" ? "font-medium text-secondary" : undefined}
          >
            {part.text}
          </span>
        ))}
      </p>
    </div>
  );
}
