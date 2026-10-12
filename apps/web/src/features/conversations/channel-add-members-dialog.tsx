import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Text } from "react-aria-components";
import { Plus, SearchLg } from "@untitledui/icons";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import {
  buildChannelCandidates,
  candidateSearchTerm,
  ChannelCandidateChips,
  ChannelCandidateGroups,
  filterChannelCandidates,
  pickedMemberIds,
  type ChannelCandidate,
} from "./channel-member-picker";
import { useChannelMembers } from "./channel-members-query";
import { channelMembersQueryKey } from "./conversation-query-keys";

/** One person or Agent an action card proposes adding. */
type ProposedMember = { id: string; displayName: string };

function proposedKeys(proposed: { humans: ProposedMember[]; agents: ProposedMember[] }) {
  return [
    ...proposed.agents.map((agent) => `agent:${agent.id}`),
    ...proposed.humans.map((human) => `user:${human.id}`),
  ];
}

/** A proposal the candidate list no longer holds (added to the channel meanwhile) still names its
 * chip, so the dialog never shows an unnamed selection. */
function proposedCandidates(proposed: {
  humans: ProposedMember[];
  agents: ProposedMember[];
}): ChannelCandidate[] {
  return [
    ...proposed.agents.map((agent) => ({
      key: `agent:${agent.id}`,
      kind: "agent" as const,
      id: agent.id,
      displayName: agent.displayName,
      search: { kind: "agent" as const, displayName: agent.displayName, name: agent.displayName },
    })),
    ...proposed.humans.map((human) => ({
      key: `user:${human.id}`,
      kind: "user" as const,
      id: human.id,
      displayName: human.displayName,
      search: { kind: "user" as const, displayName: human.displayName },
    })),
  ];
}

/**
 * Commits an Agent-prepared `channel:add_member` action card: the proposed people and Agents
 * arrive picked and individually removable, and the same search the settings panel's add view
 * uses adds anyone else the Workspace has outside the channel (ADR 0027 "Commit and cancel").
 * The channel's current roster belongs to that panel, not here: this dialog answers one
 * question, who joins #channel now.
 */
export function ChannelAddMembersDialog({
  channelId,
  channelName,
  open,
  onOpenChange,
  proposed,
  commit,
}: {
  channelId: string;
  /** Bare channel name (no leading `#`). */
  channelName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The card's proposal: picked when the dialog opens, each removable. */
  proposed: { humans: ProposedMember[]; agents: ProposedMember[] };
  /** Submitting commits the action card (marking it `executed`). */
  commit: {
    submit: (input: { userIds: string[]; agentIds: string[] }) => Promise<unknown>;
    onCommitted: () => void;
  };
}) {
  const queryClient = useQueryClient();
  const members = useChannelMembers(channelId);
  const [search, setSearch] = useState("");
  // The proposal seeds the selection once; it must not fight the human's own removals on later
  // renders while the dialog stays open.
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(proposedKeys(proposed)),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const candidates = useMemo(
    () => (members.data ? buildChannelCandidates(members.data.candidates) : []),
    [members.data],
  );
  const byKey = useMemo(
    () =>
      new Map([...proposedCandidates(proposed), ...candidates].map((entry) => [entry.key, entry])),
    [candidates, proposed],
  );
  const term = candidateSearchTerm(search);
  const shown = useMemo(() => filterChannelCandidates(candidates, term), [candidates, term]);
  const canAdd = members.data?.canAddMembers ?? false;

  function close() {
    if (submitting) return;
    onOpenChange(false);
  }

  function toggle(key: string, on: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
    setError("");
  }

  async function submit() {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError("");
    try {
      await commit.submit(pickedMemberIds(selected, byKey));
      await queryClient.invalidateQueries({ queryKey: channelMembersQueryKey(channelId) });
      commit.onCommitted();
      onOpenChange(false);
    } catch (cause) {
      setError(
        isAppError(cause) && cause.code === "ACCESS_DENIED"
          ? m.channel_members_access_denied()
          : m.channel_members_add_error(),
      );
      setSubmitting(false);
    }
  }

  return (
    <ModalOverlay
      isOpen={open}
      isDismissable={!submitting}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="flex max-h-[inherit] flex-col overflow-hidden text-left">
          <DialogHeader
            title={m.channel_members_add_to_channel({ channel: channelName })}
            onClose={submitting ? undefined : close}
          />
          {members.isPending && (
            <p className="px-6 py-6 text-sm text-tertiary">{m.channel_members_loading()}</p>
          )}
          {members.isError && (
            <p role="alert" className="px-6 py-6 text-sm text-error-primary">
              {m.channel_members_load_error()}
            </p>
          )}
          {members.data && (
            <>
              <div className="flex shrink-0 flex-col gap-3 px-6 pt-4 pb-3">
                <ChannelCandidateChips
                  keys={[...selected]}
                  byKey={byKey}
                  disabled={submitting}
                  onRemove={(key) => toggle(key, false)}
                />
                {canAdd ? (
                  // Unlike the settings panel's add view, the search does not take focus: the
                  // first thing to do here is read the proposal, and a mobile keyboard over the
                  // dialog would hide the Add button.
                  <Input
                    size="sm"
                    label={m.channel_members_search()}
                    placeholder={m.channel_members_name_placeholder()}
                    icon={SearchLg}
                    value={search}
                    onChange={setSearch}
                  />
                ) : (
                  <Text slot="description" className="block text-sm text-tertiary">
                    {m.channel_members_access_denied()}
                  </Text>
                )}
              </div>
              {canAdd && (
                <div className="min-h-0 flex-1 overflow-y-auto border-t border-secondary px-4 py-2">
                  <ChannelCandidateGroups
                    candidates={candidates}
                    shown={shown}
                    term={term}
                    selected={selected}
                    disabled={submitting}
                    onToggle={toggle}
                    inset="dialog"
                  />
                </div>
              )}
              <div className="flex shrink-0 flex-col gap-3 border-t border-secondary px-6 py-4">
                {error && (
                  <p role="alert" className="text-sm text-error-primary">
                    {error}
                  </p>
                )}
                <div className="flex justify-end gap-3">
                  <Button color="secondary" isDisabled={submitting} onPress={close}>
                    {m.channel_members_cancel()}
                  </Button>
                  <Button
                    iconLeading={Plus}
                    isDisabled={submitting || selected.size === 0}
                    isLoading={submitting}
                    showTextWhileLoading
                    onPress={() => void submit()}
                  >
                    {submitting
                      ? m.channel_members_adding()
                      : m.channel_members_add_selected({ count: selected.size })}
                  </Button>
                </div>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
