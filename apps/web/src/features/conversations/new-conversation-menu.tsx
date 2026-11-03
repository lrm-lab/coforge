import { lazy, Suspense, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { MessageSmileCircle, PlusSquare, Terminal, User01, Users01 } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { NewAgentDialog } from "#src/features/agents/new-agent-dialog";
import { m } from "#src/paraglide/messages";
import { StartDirectMessagePopover } from "./start-direct-message-popover";

const workspaceRoute = getRouteApi("/w/$workspaceSlug");

// The wizard loads when 接手本机会话 is first opened, so the Chat list does not carry it.
const LocalSessionHandoffDialog = lazy(() =>
  import("#src/features/computers/local-session-handoff-dialog").then((module) => ({
    default: module.LocalSessionHandoffDialog,
  })),
);

type Opened = "direct" | "agent" | "handoff";
const OPENED: readonly Opened[] = ["direct", "agent", "handoff"];

/**
 * The Chat list header's one "+": 新建群聊, 新建私聊 and, for a viewer whose role may create
 * Agents, 新建 Agent and 接手本机会话. 私聊's picker opens under this same "+".
 */
export function NewConversationMenu({ onCreateChannel }: { onCreateChannel: () => void }) {
  const label = m.conversation_new();
  const trigger = useRef<HTMLButtonElement>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const { canCreateAgents } = workspaceRoute.useLoaderData();
  const openOnly = (target: Opened) => (open: boolean) => setOpened(open ? target : null);
  return (
    <>
      <Dropdown.Root>
        <ButtonUtility
          ref={trigger}
          icon={PlusSquare}
          size="sm"
          color="tertiary"
          tooltip={label}
          aria-label={label}
          className="shrink-0"
        />
        <Dropdown.Popover placement="bottom start" className="w-auto min-w-37">
          <Dropdown.Menu
            aria-label={label}
            onAction={(key) => {
              if (key === "channel") onCreateChannel();
              else setOpened(OPENED.find((target) => target === key) ?? null);
            }}
          >
            <Dropdown.Item id="channel" icon={Users01} label={m.channel_create()} />
            <Dropdown.Item id="direct" icon={User01} label={m.conversation_start_direct()} />
            {canCreateAgents && (
              <>
                <Dropdown.Item id="agent" icon={MessageSmileCircle} label={m.header_new_agent()} />
                <Dropdown.Item id="handoff" icon={Terminal} label={m.handoff_title()} />
              </>
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <StartDirectMessagePopover
        triggerRef={trigger}
        isOpen={opened === "direct"}
        onOpenChange={openOnly("direct")}
      />
      <NewAgentDialog open={opened === "agent"} onOpenChange={openOnly("agent")} />
      {opened === "handoff" && (
        <Suspense fallback={null}>
          <LocalSessionHandoffDialog open onOpenChange={openOnly("handoff")} />
        </Suspense>
      )}
    </>
  );
}
