import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { BellOff01, Hash01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import type { getAgentChannels } from "#src/features/agents/agent-channels.functions";

type AgentChannelRow = Awaited<ReturnType<typeof getAgentChannels>>[number];

/** The channels listed before the rest are folded behind "Show All". */
const CHANNELS_SHOWN = 5;

/** The Chat tab's Channels rows; each opens its channel. */
export function AgentChannelList({ channels }: { channels: AgentChannelRow[] }) {
  const workspaceSlug = useWorkspaceSlug();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? channels : channels.slice(0, CHANNELS_SHOWN);
  return (
    <>
      <ul className="flex flex-col gap-2">
        {shown.map((channel) => (
          <li
            key={channel.id}
            className="relative flex min-w-0 items-center gap-3 rounded-lg px-1 py-1 hover:bg-primary_hover"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-secondary text-tertiary">
              <Hash01 aria-hidden="true" className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                {/* The link stretches over the whole row; the mute tooltip sits above it. */}
                <Link
                  to="/w/$workspaceSlug/channel/$channelId"
                  params={{ workspaceSlug, channelId: channel.id }}
                  className="truncate rounded-xs text-sm font-medium text-primary outline-focus-ring after:absolute after:inset-0 focus-visible:outline-2"
                >
                  {channel.name}
                </Link>
                {channel.muted && (
                  <Tooltip title={m.agent_chat_channel_muted()}>
                    <TooltipTrigger
                      className="relative z-10 shrink-0 text-quaternary"
                      aria-label={m.agent_chat_channel_muted()}
                    >
                      <BellOff01 aria-hidden="true" className="size-3.5" />
                    </TooltipTrigger>
                  </Tooltip>
                )}
              </div>
              {channel.description && (
                <p className="truncate text-xs text-tertiary">{channel.description}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {channels.length > CHANNELS_SHOWN && (
        <Button
          size="sm"
          color="link-gray"
          className="mt-2"
          onPress={() => setExpanded((open) => !open)}
        >
          {expanded ? m.agent_chat_show_fewer() : m.agent_chat_show_all({ count: channels.length })}
        </Button>
      )}
    </>
  );
}
