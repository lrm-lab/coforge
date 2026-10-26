import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button as AriaButton } from "react-aria-components";
import { Plus, SearchLg } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { AgentCreateDialog } from "#src/features/agents/agent-create-dialog";
import { createAgent } from "#src/features/agents/agents.functions";
import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import { isAppErrorCode } from "#src/lib/app-error";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { addPublicChannelMembers } from "./channels.functions";
import { addPublicChannelMembersReportingRefusals } from "./channel-member-additions.functions";
import {
  buildChannelCandidates,
  candidateKey,
  candidateSearchTerm,
  ChannelCandidateGroups,
  filterChannelCandidates,
  pickedMemberIds,
  type ChannelCandidate,
} from "./channel-member-picker";
import type { ChannelMembers } from "./channel-members-query";
import { channelMembersQueryKey } from "./conversation-query-keys";

export function AddMembersView({
  channelId,
  channelName,
  canCreateAgents,
  createdAgentJoin,
  data,
  onDone,
}: {
  channelId: string;
  channelName: string;
  canCreateAgents: boolean;
  createdAgentJoin: CreatedAgentJoin;
  data: ChannelMembers;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const add = useServerFn(addPublicChannelMembersReportingRefusals);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // Picks that failed to join, kept so their rows and a retry still find them once the fresh
  // roster no longer offers them (a private Agent or someone who left the Workspace is no
  // candidate). One the roster lists as a member by now (added before a failed request) drops out.
  const [retained, setRetained] = useState<ChannelCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const candidates = useMemo<ChannelCandidate[]>(
    () => buildChannelCandidates(data.candidates),
    [data.candidates],
  );
  // The selection shows only as ticked rows, so a retained pick the roster no longer offers is
  // listed ahead of the candidates, where its row can still be unticked.
  const listed = useMemo(() => {
    const listedKeys = new Set([
      ...data.humans.map((human) => candidateKey("user", human.id)),
      ...data.agents.map((agent) => candidateKey("agent", agent.id)),
      ...candidates.map((entry) => entry.key),
    ]);
    return [...retained.filter((entry) => !listedKeys.has(entry.key)), ...candidates];
  }, [retained, candidates, data.humans, data.agents]);
  const byKey = useMemo(() => new Map(listed.map((entry) => [entry.key, entry])), [listed]);
  const term = candidateSearchTerm(search);
  const shown = useMemo(() => filterChannelCandidates(listed, term), [listed, term]);
  const { joining, failure, notStarted } = createdAgentJoin;
  // Joined some other way meanwhile (a refetch, another member): nothing left to retry.
  const unjoined =
    failure && !data.agents.some((agent) => agent.id === failure.agent.id) ? failure : null;
  const createName = term && shown.length === 0 ? term : "";

  async function joinCreated(agent: CreatedAgent, startPublished: boolean) {
    if (await createdAgentJoin.join(agent, startPublished)) {
      // The search named the new Agent; clear it so the list stops offering to create it again.
      setSearch("");
    } else {
      // Like any pick, the new Agent is selected, so Add selected retries it too.
      setSelected((previous) => new Set(previous).add(candidateKey("agent", agent.id)));
    }
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
    setBusy(true);
    setError("");
    try {
      const picked = pickedMemberIds(selected, byKey);
      const { members, failed } = await add({ data: { channelId, ...picked } });
      queryClient.setQueryData(channelMembersQueryKey(channelId), members);
      if (failed.length === 0) return onDone();
      // The ones that joined leave the selection; the rest stay picked so Add retries them.
      const failedKeys = new Set(failed.map((entry) => candidateKey(entry.kind, entry.id)));
      setRetained([...failedKeys].flatMap((key) => byKey.get(key) ?? []));
      setSelected(failedKeys);
      setError(
        failed.length === picked.userIds.length + picked.agentIds.length
          ? m.channel_members_add_none()
          : m.channel_members_add_partial(),
      );
    } catch (cause) {
      // The request may have failed after the batch fell back to one pick at a time, with some
      // already added: reread the roster so they show as members and leave the selection.
      void queryClient.invalidateQueries({ queryKey: channelMembersQueryKey(channelId) });
      setError(
        isAppErrorCode(cause, "ACCESS_DENIED")
          ? m.channel_members_access_denied()
          : m.channel_members_add_error(),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 px-4 py-3 md:px-6">
        {unjoined && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-lg bg-warning-primary px-3 py-2.5"
          >
            <p className="text-sm font-medium text-warning-primary">
              {m.channel_members_create_agent_join_failed({
                name: unjoined.agent.name,
                channel: channelName,
              })}
            </p>
            <p className="text-sm text-secondary">{unjoined.reason}</p>
            {unjoined.retryable && (
              <Button
                size="sm"
                color="secondary"
                className="self-start"
                isDisabled={busy || joining}
                isLoading={joining}
                showTextWhileLoading
                onPress={() => void joinCreated(unjoined.agent, !notStarted)}
              >
                {m.channel_members_retry_join()}
              </Button>
            )}
          </div>
        )}
        {notStarted && (
          <p role="status" className="text-sm text-secondary">
            {m.agent_deferred_start_notice()}
          </p>
        )}
        <Input
          size="sm"
          label={m.channel_members_search()}
          placeholder={m.channel_members_name_placeholder()}
          icon={SearchLg}
          value={search}
          onChange={setSearch}
          autoFocus
        />
      </div>
      {/* One bordered box holds the candidates, scrolling inside it, and ends with the create
          entry, so creating reads as the list's last option. */}
      <div className="mx-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-secondary md:mx-6">
        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          <ChannelCandidateGroups
            candidates={listed}
            shown={shown}
            term={term}
            selected={selected}
            disabled={busy}
            onToggle={toggle}
            inset="box"
          />
        </div>
        <CreateAgentEntry
          channelName={channelName}
          canCreate={canCreateAgents}
          name={createName}
          nameNote={createName ? prefillNote(search.trim(), createName) : undefined}
          // A created Agent that has not joined yet is retried above, never created again.
          disabled={busy || joining || unjoined !== null}
          onCreated={(agent, startPublished) => void joinCreated(agent, startPublished)}
        />
      </div>
      <div className="flex shrink-0 flex-col gap-2 px-4 py-3 md:px-6">
        {error && (
          <p role="alert" className="text-sm text-error-primary">
            {error}
          </p>
        )}
        <Button
          color="secondary"
          iconLeading={Plus}
          className="w-full"
          isDisabled={busy || joining || selected.size === 0}
          isLoading={busy}
          showTextWhileLoading
          onPress={() => void submit()}
        >
          {busy
            ? m.channel_members_adding()
            : m.channel_members_add_selected({ count: selected.size })}
        </Button>
      </div>
    </div>
  );
}

type CreatedAgent = { id: string; name: string };
type CreatedAgentJoin = ReturnType<typeof useCreatedAgentJoin>;

/** Why a created Agent did not join, and whether trying again can help. */
function joinFailure(cause: unknown) {
  if (isAppErrorCode(cause, "ACCESS_DENIED"))
    return { reason: m.channel_members_access_denied(), retryable: false };
  if (isAppErrorCode(cause, "CONFLICT"))
    return { reason: m.channel_archived_notice(), retryable: false };
  return { reason: m.channel_members_create_agent_join_failed_hint(), retryable: true };
}

/** What the name field says about a name taken from the search: a stripped leading @, and spaces
 * the username cannot hold, which are left for the person to resolve. */
function prefillNote(search: string, name: string) {
  const notes = [
    ...(search.startsWith("@") ? [m.channel_members_prefill_at_stripped()] : []),
    ...(/\s/.test(name)
      ? [
          m.channel_members_prefill_spaces_kept({
            dashed: name.replace(/\s+/g, "-"),
            joined: name.replace(/\s+/g, ""),
          }),
        ]
      : []),
  ];
  return notes.join(" ") || undefined;
}

/**
 * Adds an Agent just created from the add view to the channel. Held by the members page rather
 * than the add view, so a join still running when the add view closes keeps its outcome.
 */
export function useCreatedAgentJoin(channelId: string) {
  const queryClient = useQueryClient();
  const add = useServerFn(addPublicChannelMembers);
  const [joining, setJoining] = useState(false);
  const [failure, setFailure] = useState<
    ({ agent: CreatedAgent } & ReturnType<typeof joinFailure>) | null
  >(null);
  const [notStarted, setNotStarted] = useState(false);

  /** Resolves `true` once the Agent is in the channel. */
  async function join(agent: CreatedAgent, startPublished: boolean) {
    setJoining(true);
    setNotStarted(!startPublished);
    try {
      const fresh = await add({ data: { channelId, userIds: [], agentIds: [agent.id] } });
      queryClient.setQueryData(channelMembersQueryKey(channelId), fresh);
      setFailure(null);
      return true;
    } catch (cause) {
      setFailure({ agent, ...joinFailure(cause) });
      // The new Agent is a candidate now; list it.
      void queryClient.invalidateQueries({ queryKey: channelMembersQueryKey(channelId) });
      return false;
    } finally {
      setJoining(false);
    }
  }

  return { joining, failure, notStarted, join };
}

/** The last row of the add view's candidate box: create an Agent (named after a search that
 * matched nobody) that joins the channel once created. A viewer who may not create Agents sees why
 * instead. */
function CreateAgentEntry({
  channelName,
  canCreate,
  name,
  nameNote,
  disabled,
  onCreated,
}: {
  channelName: string;
  canCreate: boolean;
  /** The search that matched nobody, or empty. */
  name: string;
  nameNote?: string;
  disabled: boolean;
  onCreated: (agent: CreatedAgent, startPublished: boolean) => void;
}) {
  const loadComputers = useServerFn(listComputers);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const create = useServerFn(createAgent);
  const [computers, setComputers] = useState<Awaited<ReturnType<typeof listComputers>>>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  async function open() {
    setLoading(true);
    setLoadError("");
    try {
      // Read on every open: a Computer may have come online or gone since the last one.
      setComputers(await loadComputers());
      setDialogOpen(true);
    } catch {
      setLoadError(m.channel_members_computers_error());
    } finally {
      setLoading(false);
    }
  }

  if (!canCreate)
    return (
      <div className="shrink-0 border-t border-secondary p-3">
        <p className="flex items-center gap-2 text-sm font-medium text-quaternary">
          <Plus aria-hidden="true" className="size-4 shrink-0" />
          {m.channel_members_create_agent()}
        </p>
        <p className="mt-1 text-sm text-tertiary">{m.channel_members_create_agent_denied()}</p>
      </div>
    );

  return (
    <div className="shrink-0 border-t border-secondary">
      {loadError && (
        <p role="alert" className="px-3 pt-3 text-sm text-error-primary">
          {loadError}
        </p>
      )}
      <AriaButton
        isDisabled={disabled || loading}
        onPress={() => void open()}
        className={cn(
          "flex w-full cursor-pointer items-center gap-3 p-3 text-left outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60",
          name && "bg-secondary",
        )}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-primary text-fg-quaternary">
          <Plus aria-hidden="true" className="size-3.5" />
        </span>
        {/* One line: the action, then where the new Agent goes in brackets, in the note's style. */}
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-medium text-primary">
            {name
              ? m.channel_members_create_agent_named({ name })
              : m.channel_members_create_agent()}
          </span>{" "}
          <span className="text-tertiary">
            {m.channel_members_create_agent_joins({ channel: channelName })}
          </span>
        </span>
      </AriaButton>
      {dialogOpen && computers && (
        <AgentCreateDialog
          open
          onOpenChange={setDialogOpen}
          computers={computers}
          onLoadRuntimeCatalog={(computerId) => loadRuntimeCatalog({ data: { computerId } })}
          // Read once when the form mounts, so typing afterwards does not rename the draft.
          defaults={{ name }}
          nameNote={nameNote}
          joinsChannelName={channelName}
          visibilityLocked
          onCreate={async (input) => {
            const created = await create({ data: input });
            onCreated(
              { id: created.agent.id, name: created.agent.displayName || created.agent.name },
              created.startPublished,
            );
            return created;
          }}
        />
      )}
    </div>
  );
}
