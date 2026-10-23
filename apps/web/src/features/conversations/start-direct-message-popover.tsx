import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight, Cloud01, Plus } from "@untitledui/icons";
import { Spinner } from "#src/components/ui/spinner";
import { Heading, Popover as AriaPopover } from "react-aria-components";

import { Dialog, DialogTrigger } from "#src/components/application/modals/modal";
import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { IdentityAvatar } from "#src/features/agents/avatar-sticker";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { loadWorkspaceDirectory } from "#src/features/workspaces/workspaces.functions";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import { useOpenDirectConversation } from "./open-direct-conversation";
import { useCloseConversationList } from "./conversation-navigation";
import { CloudAgentCreateDialog } from "#src/features/agents/cloud-agent-create-dialog";

/**
 * The Direct messages "+": a popover under the button with a member search and an Agent / Human
 * tab each. Picking someone opens or starts their DM. An authorized viewer can also create a
 * private cloud Bot through the shared cloud Agent dialog.
 */
export function StartDirectMessagePopover() {
  const label = m.conversation_start_direct();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <>
      <DialogTrigger isOpen={pickerOpen} onOpenChange={setPickerOpen}>
        <ButtonUtility
          icon={Plus}
          size="xs"
          color="tertiary"
          tooltip={label}
          aria-label={label}
          className="shrink-0 hover:bg-transparent!"
        />
        <AriaPopover
          placement="bottom start"
          offset={8}
          className="h-[23.75rem] w-[19.5rem] rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-none"
        >
          <Dialog className="flex h-full flex-col overflow-hidden outline-none">
            {({ close }) => (
              <DirectMessagePicker
                onDone={close}
                onCreate={() => {
                  setPickerOpen(false);
                  setCreateOpen(true);
                }}
              />
            )}
          </Dialog>
        </AriaPopover>
      </DialogTrigger>
      <CloudAgentCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

type Member = {
  id: string;
  name: string;
  avatarUrl?: string | null;
  peer: { agentId: string } | { userId: string };
};

function DirectMessagePicker({ onDone, onCreate }: { onDone: () => void; onCreate: () => void }) {
  const workspaceId = useCurrentWorkspaceId();
  const load = useServerFn(loadWorkspaceDirectory);
  const directory = useQuery({
    queryKey: ["direct-message-directory", workspaceId],
    queryFn: () => load(),
    enabled: !!workspaceId,
  });
  const [error, setError] = useState("");
  const openDirect = useOpenDirectConversation(() => setError(m.conversation_open_error()));
  const closeList = useCloseConversationList();
  const [search, setSearch] = useState("");
  const [opening, setOpening] = useState(false);
  const busy = useRef(false);
  const query = search.trim().toLowerCase();
  const matches = (...names: (string | null)[]) =>
    names.some((name) => name?.toLowerCase().includes(query));
  const groups: { id: string; label: string; members: Member[] }[] = [
    {
      id: "agents",
      label: m.member_agent(),
      members: (directory.data?.agents ?? [])
        .filter((agent) => agent.canMessage && matches(agent.name, agent.handle))
        .map((agent) => ({ ...agent, peer: { agentId: agent.id } })),
    },
    {
      id: "people",
      label: m.member_person(),
      members: (directory.data?.people ?? [])
        .filter((person) => matches(person.name))
        .map((person) => ({
          ...person,
          name:
            person.id === directory.data?.viewerId
              ? m.conversation_dm_self_name({ name: person.name })
              : person.name,
          peer: { userId: person.id },
        })),
    },
  ];

  async function select(peer: Member["peer"]) {
    if (busy.current) return;
    busy.current = true;
    setOpening(true);
    setError("");
    try {
      if (await openDirect(peer)) {
        closeList();
        onDone();
      }
    } finally {
      busy.current = false;
      setOpening(false);
    }
  }

  return (
    <>
      <Heading
        slot="title"
        className="shrink-0 border-b border-secondary px-4 py-3 text-md font-semibold text-primary"
      >
        {m.conversation_start_direct()}
      </Heading>
      <div className="shrink-0 px-4 pt-3">
        <Input
          aria-label={m.channel_members_search_placeholder()}
          placeholder={m.channel_members_search_placeholder()}
          value={search}
          onChange={setSearch}
          autoFocus
        />
      </div>
      {error && (
        <p role="alert" className="shrink-0 px-4 pt-2 text-sm text-error-primary">
          {error}
        </p>
      )}
      {opening && (
        <p
          role="status"
          className="flex shrink-0 items-center gap-2 px-4 pt-2 text-sm text-tertiary"
        >
          <Spinner className="size-4" />
          {m.conversation_opening_direct()}
        </p>
      )}
      {directory.isPending && (
        <p className="px-4 pt-4 text-sm text-tertiary">{m.channel_members_loading()}</p>
      )}
      {directory.isError && (
        <div className="flex flex-col items-start gap-3 px-4 pt-4">
          <p role="alert" className="text-sm text-error-primary">
            {m.channel_members_load_error()}
          </p>
          <Button color="secondary" size="sm" onPress={() => void directory.refetch()}>
            {m.controls_retry()}
          </Button>
        </div>
      )}
      {directory.isSuccess && (
        <Tabs className="flex min-h-0 flex-1 flex-col" aria-busy={opening}>
          <TabList
            aria-label={m.conversation_start_direct()}
            type="underline"
            className="mt-3 shrink-0 gap-6 px-4"
          >
            {groups.map((group) => (
              <Tab key={group.id} id={group.id}>
                {group.label}
              </Tab>
            ))}
          </TabList>
          {groups.map((group) => (
            <TabPanel
              key={group.id}
              id={group.id}
              className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
            >
              {group.members.length === 0 ? (
                <p className="px-2 py-2 text-sm text-tertiary">{m.channel_members_none()}</p>
              ) : (
                <ul className="flex flex-col">
                  {group.members.map((member) => (
                    <li key={member.id}>
                      <Button
                        color="tertiary"
                        size="md"
                        className="w-full min-w-0 justify-start text-md font-normal [&>[data-text]]:min-w-0"
                        isDisabled={opening}
                        onPress={() => void select(member.peer)}
                        iconLeading={
                          <IdentityAvatar
                            size="xs"
                            alt={member.name}
                            src={member.avatarUrl ?? undefined}
                            initials={avatarInitial(member.name)}
                            contentClassName={avatarToneClassName(member.name)}
                          />
                        }
                      >
                        <span className="block truncate">{member.name}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </TabPanel>
          ))}
        </Tabs>
      )}
      {directory.data?.canCreateAgents && (
        <div className="shrink-0 border-t border-secondary p-3">
          <Button
            color="tertiary"
            size="md"
            iconLeading={Cloud01}
            iconTrailing={ArrowRight}
            className="w-full justify-start gap-2 bg-utility-brand-50 text-utility-brand-700 ring-1 ring-utility-brand-200 ring-inset hover:bg-utility-brand-100 hover:text-utility-brand-700 [&>[data-text]]:flex-1 [&>[data-text]]:text-left *:data-icon:text-utility-brand-600 hover:*:data-icon:text-utility-brand-700"
            isDisabled={opening}
            onPress={onCreate}
          >
            {m.cloud_agent_create_title()}
          </Button>
        </div>
      )}
    </>
  );
}
