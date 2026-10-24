import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AvatarSticker } from "#src/features/avatars/avatar-sticker";
import { useNearViewport } from "#src/hooks/use-near-viewport";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";

import type { BusyAgent } from "./busy-agents";
import { waitingCount, type CastMember } from "./busy-agents-cast";
import { BusyAgentsCount } from "./busy-agents-list";
import { mountMascot, newStageLive, useStageLoop, type StageLive } from "./busy-agents-stage-loop";
import { AgentHoverCard } from "./agent-hover-card";
import { AgentMascotView } from "./agent-mascot-view";
import type { OpenAgentProfile } from "./profile-panel/open-agent-profile";
import { useWorkspaceBusyAgents } from "./use-workspace-busy-agents";

/** One mascot on the stage. It registers its element with the loop, which moves it. */
function StageMascot({
  agent,
  resting,
  still,
  live,
  onOpenAgent,
}: {
  agent: BusyAgent;
  /** The Agent has stopped and is walking off: it acts out its rest. */
  resting: boolean;
  still: boolean;
  live: StageLive;
  onOpenAgent: OpenAgentProfile;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    return el ? mountMascot(live, agent.id, el) : undefined;
  }, [live, agent.id]);
  return (
    <span ref={ref} className="absolute top-3.5 left-0 size-6">
      <AgentHoverCard
        agentId={agent.id}
        name={agent.name}
        handle={agent.handle}
        src={agent.avatarUrl}
        onOpenProfile={onOpenAgent}
        triggerClassName="relative flex size-6 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand"
        trigger={
          <span data-mascot-body className="block size-6 origin-[50%_94%] will-change-transform">
            <AvatarSticker size="xs">
              <AgentMascotView
                mascot={agent.mascot}
                activity={resting ? "idle" : agent.activity}
                still={still}
              />
            </AvatarSticker>
          </span>
        }
      />
    </span>
  );
}

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/**
 * The chat list header's stage: up to five of the busy Agents' mascots slide out from behind the
 * count, work and wander a while, and slide back in to make room for others. Each is the Agent's
 * avatar anywhere else: hovering peeks at its card, pressing opens its profile. The count opens
 * all of them. The cast is decided by `busy-agents-cast.ts`, the motion by
 * `busy-agents-motion.ts`, both run by `useStageLoop`, so React renders only when someone comes
 * on or goes off.
 */
export const BusyAgentsStage = memo(
  function BusyAgentsStage({
    directAgentIds,
    onOpenAgent,
  }: {
    /** Agents the viewer has a direct conversation with: they come first. */
    directAgentIds: ReadonlySet<string>;
    /** The same function on every render, or the stage repaints with each one. */
    onOpenAgent: OpenAgentProfile;
  }) {
    const busy = useWorkspaceBusyAgents(directAgentIds);
    const ids = useMemo(() => busy.map((agent) => agent.id), [busy]);
    const reduced = usePrefersReducedMotion();
    const [live] = useState(newStageLive);
    const [members, setMembers] = useState<readonly CastMember[]>([]);
    const [stage, setStage] = useState<HTMLElement | null>(null);
    const [watch, visible] = useNearViewport(true, "0px");
    const stageRef = useCallback(
      (el: HTMLElement | null) => {
        setStage(el);
        watch(el);
      },
      [watch],
    );
    useStageLoop({ live, stage, visible, busy: ids, reduced, setMembers });

    // A stopped Agent still walks off: it keeps the last picture it had, acting out its rest.
    const known = useRef(new Map<string, BusyAgent>());
    for (const agent of busy) known.current.set(agent.id, agent);
    const busyIds = useMemo(() => new Set(ids), [ids]);
    const waiting = waitingCount(members, ids);
    if (busy.length === 0 && members.length === 0) return null;
    return (
      <div className="flex h-full min-w-0 flex-1 items-center">
        <div ref={stageRef} className="relative h-full min-w-0 flex-1 overflow-hidden">
          {members.map((member) => {
            const agent = known.current.get(member.id);
            return (
              agent && (
                <StageMascot
                  key={member.id}
                  agent={agent}
                  resting={!busyIds.has(member.id)}
                  still={reduced}
                  live={live}
                  onOpenAgent={onOpenAgent}
                />
              )
            );
          })}
        </div>
        {waiting > 0 && (
          <BusyAgentsCount agents={busy} waiting={waiting} onOpenAgent={onOpenAgent} />
        )}
      </div>
    );
  },
  (previous, next) =>
    previous.onOpenAgent === next.onOpenAgent &&
    sameIds(previous.directAgentIds, next.directAgentIds),
);
