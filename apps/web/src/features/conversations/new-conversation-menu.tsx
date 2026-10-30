import { useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { MessageSmileCircle, PlusSquare, User01, Users01 } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { CloudAgentCreateDialog } from "#src/features/agents/cloud-agent-create-dialog";
import { m } from "#src/paraglide/messages";
import { StartDirectMessagePopover } from "./start-direct-message-popover";

const workspaceRoute = getRouteApi("/w/$workspaceSlug");

/**
 * The Chat list header's one "+": 新建群聊, 新建私聊 and, for a viewer whose role may create
 * Agents, 新建智能体. 私聊's picker opens under this same "+".
 */
export function NewConversationMenu({ onCreateChannel }: { onCreateChannel: () => void }) {
  const label = m.conversation_new();
  const trigger = useRef<HTMLButtonElement>(null);
  const [opened, setOpened] = useState<"direct" | "agent" | null>(null);
  const { canCreateAgents } = workspaceRoute.useLoaderData();
  const openOnly = (target: "direct" | "agent") => (open: boolean) =>
    setOpened(open ? target : null);
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
            onAction={(key) =>
              key === "channel" ? onCreateChannel() : setOpened(key as "direct" | "agent")
            }
          >
            <Dropdown.Item id="channel" icon={Users01} label={m.channel_create()} />
            <Dropdown.Item id="direct" icon={User01} label={m.conversation_start_direct()} />
            {canCreateAgents && (
              <Dropdown.Item id="agent" icon={MessageSmileCircle} label={m.header_new_agent()} />
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <StartDirectMessagePopover
        triggerRef={trigger}
        isOpen={opened === "direct"}
        onOpenChange={openOnly("direct")}
      />
      <CloudAgentCreateDialog open={opened === "agent"} onOpenChange={openOnly("agent")} />
    </>
  );
}
