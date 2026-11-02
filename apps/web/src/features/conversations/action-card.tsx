import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { Button } from "#src/components/base/buttons/button";
import { Badge } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";
import { isAppErrorCode } from "#src/lib/app-error";
import { APP_GRANT_REQUEST_CHANGED } from "#src/features/apps/agent-app-access";
import {
  cancelActionCard,
  commitChannelAddMemberActionCard,
  commitAppGrantActionCard,
  commitAppRecoverOwnerActionCard,
  commitAppRegisterActionCard,
  commitChannelCreateActionCard,
  commitChoiceActionCard,
  commitDesktopTakeoverActionCard,
  commitPageFillActionCard,
  denyAppGrantActionCard,
  loadActionCardStates,
} from "./action-cards.functions";
import { CreateChannelDialog } from "./create-channel-dialog";
import { ChannelAddMembersDialog } from "./channel-add-members-dialog";
import { ActionCardAppBody } from "./action-card-app-body";
import { ChoiceActionCard } from "./action-card-choice";
import {
  ActionCardDesktopTakeoverBody,
  ActionCardHandoffDoneSuffix,
  ActionCardOpenDesktopButton,
  ActionCardPageFillBody,
} from "./action-card-handoff";
import {
  actionCardCommitLabel,
  actionCardDeniedReason,
  actionCardIcon,
  actionCardTitle,
} from "./action-card-labels";
import { AgentCreateDialog } from "#src/features/agents/agent-create-dialog";
import { createAgent } from "#src/features/agents/agents.functions";
import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import { getCloudDesktopOrigin } from "#src/features/computers/cloud-desktop-origin.functions";
import { cloudDesktopUrl, openCloudDesktopWindow } from "#src/features/computers/cloud-desktop-url";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { projectsQuery } from "#src/features/projects/project-tree-queries";
import type { ActionCardRef, ActionCardView } from "#src/server/conversations/action-cards.server";

function chipList(items: ActionCardRef[]) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item.id} size="sm" color="gray">
          @{item.displayName}
        </Badge>
      ))}
    </div>
  );
}

/** Renders an Agent-prepared action card below its message body.
 * Owns its own commit/cancel dialogs and a self-refresh after acting; the conversation view also
 * refreshes every currently pending card on realtime signals and window focus (see
 * `conversation-queries.ts`). */
export function ActionCard({ card }: { card: ActionCardView }) {
  const workspaceSlug = useWorkspaceSlug();
  const [view, setView] = useState(card);
  useEffect(() => setView(card), [card]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const cancel = useServerFn(cancelActionCard);
  const refresh = useServerFn(loadActionCardStates);
  const commitChannelCreate = useServerFn(commitChannelCreateActionCard);
  const commitAddMember = useServerFn(commitChannelAddMemberActionCard);
  const approveAppGrant = useServerFn(commitAppGrantActionCard);
  const denyAppGrant = useServerFn(denyAppGrantActionCard);
  const registerApp = useServerFn(commitAppRegisterActionCard);
  const recoverOwner = useServerFn(commitAppRecoverOwnerActionCard);
  const commitFill = useServerFn(commitPageFillActionCard);
  const commitDesktop = useServerFn(commitDesktopTakeoverActionCard);
  const commitChoice = useServerFn(commitChoiceActionCard);
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const isPageFill = view.kind === "page:fill";
  const isDesktopTakeover = view.kind === "desktop:takeover";
  // Known only to someone in the channel, who alone may commit (task #302).
  const addMemberChannelId = view.kind === "channel:add_member" ? view.channel.id : null;
  const [approving, setApproving] = useState(false);
  const isAppGrant = view.kind === "app:grant_agent";
  const isAppRegister = view.kind === "app:register";
  // A channel card's dialog offers the Workspace's Projects, with the card's suggestion picked. The
  // dialog opens once they have been read, so the suggestion is there when its form mounts.
  const workspaceId = useCurrentWorkspaceId();
  const projects = useQuery({
    ...projectsQuery(workspaceId ?? ""),
    enabled: view.kind === "channel:create" && Boolean(workspaceId),
  });
  const isRecoverOwner = view.kind === "app:recover_owner";
  const create = useServerFn(createAgent);
  const loadComputers = useServerFn(listComputers);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const [computers, setComputers] = useState<Awaited<ReturnType<typeof listComputers>>>();
  const loadDesktopOrigin = useServerFn(getCloudDesktopOrigin);
  const desktopComputerId =
    view.kind === "page:fill" || view.kind === "desktop:takeover" ? view.computerId : undefined;
  const desktopAgentId =
    view.kind === "page:fill" || view.kind === "desktop:takeover" ? view.agentId : undefined;
  const desktopTitle = view.kind === "desktop:takeover" ? view.agentName : undefined;
  const desktopOrigin = useQuery({
    queryKey: ["cloud-desktop-origin"],
    queryFn: () => loadDesktopOrigin(),
    enabled: Boolean(desktopComputerId && desktopAgentId),
    staleTime: 60_000,
  });
  const desktopUrl =
    desktopOrigin.data && desktopComputerId && desktopAgentId
      ? cloudDesktopUrl(desktopOrigin.data, desktopComputerId, desktopAgentId, desktopTitle)
      : undefined;

  function openDesktop() {
    if (!desktopUrl || !desktopComputerId || !desktopAgentId) return;
    openCloudDesktopWindow(desktopUrl, desktopComputerId, desktopAgentId);
  }

  async function refetch() {
    const states = await refresh({ data: { messageIds: [view.messageId] } });
    const next = states[view.messageId] as ActionCardView | undefined;
    if (next) setView(next);
  }

  async function doCancel() {
    setCancelling(true);
    setError("");
    try {
      // An app approval card is cancelled by denying the Agent's request.
      await (isAppGrant ? denyAppGrant : cancel)({ data: { messageId: view.messageId } });
      await refetch();
    } catch {
      setError(m.action_card_error());
    } finally {
      setCancelling(false);
    }
  }

  async function approve() {
    setApproving(true);
    setError("");
    try {
      await approveAppGrant({
        data: {
          messageId: view.messageId,
          scopes: view.kind === "app:grant_agent" ? view.scopes : [],
        },
      });
      await refetch();
    } catch (cause) {
      if (isAppErrorCode(cause, "CONFLICT") && cause.errorId === APP_GRANT_REQUEST_CHANGED) {
        // The request asks for other scopes than the card showed: show the card again.
        await refetch().catch(() => {});
        setError(m.app_card_request_changed());
      } else setError(m.action_card_error());
    } finally {
      setApproving(false);
    }
  }

  async function fillPage() {
    if (view.kind !== "page:fill") return;
    setApproving(true);
    setError("");
    try {
      await commitFill({ data: { messageId: view.messageId, values: fillValues } });
      setFillValues({});
      await refetch();
    } catch (cause) {
      if (
        isAppErrorCode(cause, "TEMPORARILY_UNAVAILABLE") &&
        cause.errorId === "page-fill-browser"
      ) {
        setError(m.action_card_page_fill_browser());
      } else if (
        isAppErrorCode(cause, "TEMPORARILY_UNAVAILABLE") &&
        cause.errorId === "page-fill-desktop"
      ) {
        setError(m.action_card_page_fill_desktop());
      } else if (isAppErrorCode(cause, "INVALID_INPUT") && cause.errorId === "page-fill-field") {
        setError(m.action_card_page_fill_field());
      } else setError(m.action_card_error());
    } finally {
      setApproving(false);
    }
  }

  async function finishDesktop() {
    if (view.kind !== "desktop:takeover") return;
    setApproving(true);
    setError("");
    try {
      await commitDesktop({ data: { messageId: view.messageId } });
      await refetch();
    } catch {
      setError(m.action_card_error());
    } finally {
      setApproving(false);
    }
  }

  async function pickChoice(optionId: string) {
    setError("");
    try {
      await commitChoice({ data: { messageId: view.messageId, optionId } });
      await refetch();
    } catch {
      setError(m.action_card_error());
    }
  }

  async function register() {
    setApproving(true);
    setError("");
    try {
      await (isRecoverOwner ? recoverOwner : registerApp)({ data: { messageId: view.messageId } });
      await refetch();
    } catch {
      setError(m.action_card_error());
    } finally {
      setApproving(false);
    }
  }

  async function openDialog() {
    setError("");
    if (isAppGrant) return approve();
    if (isAppRegister || isRecoverOwner) return register();
    if (view.kind === "agent:create" && !computers) {
      try {
        setComputers(await loadComputers());
      } catch {
        setError(m.action_card_error());
        return;
      }
    }
    setDialogOpen(true);
  }

  if (view.kind === "choice")
    return (
      <ChoiceActionCard
        view={view}
        error={error}
        cancelling={cancelling}
        onPick={pickChoice}
        onCancel={() => void doCancel()}
      />
    );
  const Icon = actionCardIcon(view.kind);
  const title = actionCardTitle(view);
  const commitLabel = actionCardCommitLabel(view, approving);
  const deniedReason = actionCardDeniedReason(view);
  return (
    <div className="mt-1 flex max-w-md flex-col gap-3 rounded-xl border border-secondary bg-primary p-4 shadow-xs">
      <div className="flex items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-tertiary ring-1 ring-secondary ring-inset">
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">{title}</span>
        {view.state === "pending" && (
          <Badge size="sm" color="gray">
            {m.action_card_state_pending()}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-1.5 text-sm text-secondary">
        {view.kind === "channel:create" && (
          <>
            <p>
              #{view.name} · {view.visibility === "public" ? m.channel_public() : view.visibility}
            </p>
            {view.description && <p className="text-tertiary">{view.description}</p>}
            {chipList([...view.initialHumans, ...view.initialAgents])}
          </>
        )}
        {view.kind === "agent:create" && (
          <>
            <p>{view.name}</p>
            {view.description && <p className="text-tertiary">{view.description}</p>}
            {(view.requiredComputer ?? view.suggestedComputer) && (
              <p className="text-tertiary">
                {view.requiredComputer
                  ? m.action_card_required_computer({
                      name: view.requiredComputer.displayName,
                    })
                  : m.action_card_suggested_computer({
                      name: view.suggestedComputer!.displayName,
                    })}
              </p>
            )}
          </>
        )}
        {view.kind === "channel:add_member" && (
          <>
            <p>#{view.channel.displayName}</p>
            {chipList([...view.humans, ...view.agents])}
          </>
        )}
        {(view.kind === "app:grant_agent" ||
          view.kind === "app:recover_owner" ||
          view.kind === "app:register") && <ActionCardAppBody view={view} />}
        {view.kind === "page:fill" && (
          <ActionCardPageFillBody
            view={view}
            fillValues={fillValues}
            setFillValues={setFillValues}
          />
        )}
        {view.kind === "desktop:takeover" && <ActionCardDesktopTakeoverBody view={view} />}
        {view.draftHint && <p className="text-xs text-tertiary italic">{view.draftHint}</p>}
      </div>

      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {error}
        </p>
      )}

      {view.state === "pending" && (
        <div className="flex flex-wrap items-center gap-2">
          {view.canCommit ? (
            <Button
              size="sm"
              isDisabled={
                approving ||
                (view.kind === "page:fill" &&
                  view.fields.some(
                    (field) => field.input === "password" && !(fillValues[field.id] ?? "").length,
                  ))
              }
              onPress={() => {
                if (isPageFill) void fillPage();
                else if (isDesktopTakeover) void finishDesktop();
                else void openDialog();
              }}
            >
              {commitLabel}
            </Button>
          ) : (
            <p className="text-xs text-tertiary">{deniedReason}</p>
          )}
          <ActionCardOpenDesktopButton
            enabled={Boolean((isPageFill || isDesktopTakeover) && view.canCommit && desktopUrl)}
            onOpen={openDesktop}
          />
          {view.canCancel && (
            <Button
              size="sm"
              color="tertiary"
              isDisabled={cancelling}
              onPress={() => void doCancel()}
            >
              {isAppGrant
                ? cancelling
                  ? m.app_card_denying()
                  : m.agent_apps_deny()
                : cancelling
                  ? m.action_card_cancelling()
                  : m.action_card_dismiss()}
            </Button>
          )}
        </div>
      )}
      {view.state === "executed" && (
        <p className="text-xs text-tertiary">
          {m.action_card_done({
            name: view.committedBy?.displayName ?? m.action_card_unknown(),
            time: view.committedAt ? new Date(view.committedAt).toLocaleString() : "",
          })}
          <ActionCardHandoffDoneSuffix view={view} />
          {view.kind === "channel:create" && view.result && (
            <>
              {" · "}
              <Link
                to="/w/$workspaceSlug/channel/$channelId"
                params={{ workspaceSlug, channelId: view.result.channelId }}
                className="text-brand-secondary hover:underline"
              >
                #{view.name}
              </Link>
            </>
          )}
          {view.kind === "app:recover_owner" && view.result && (
            <>
              {" · "}
              {m.app_recover_card_done({ agent: view.result.ownerAgent })}
            </>
          )}
          {view.kind === "app:register" && view.result && (
            <>
              {" · "}
              {view.result.clientKey}
              <br />
              {view.result.noOwnerAgent
                ? m.app_register_card_no_owner_agent()
                : m.app_register_card_secret_sent()}
            </>
          )}
          {view.kind === "agent:create" && view.result && (
            <>
              {" · "}
              <Link
                to="/w/$workspaceSlug/members"
                params={{ workspaceSlug }}
                search={{
                  profile: formatAgentProfileParam(view.result.agentId),
                  agentTab: "profile",
                }}
                className="text-brand-secondary hover:underline"
              >
                {view.name}
              </Link>
            </>
          )}
        </p>
      )}
      {view.state === "cancelled" && (
        <p className="text-xs text-tertiary">
          {isAppGrant ? m.app_card_denied() : m.action_card_cancelled()}
        </p>
      )}

      {dialogOpen && view.kind === "channel:create" && !projects.isPending && (
        <CreateChannelDialog
          open
          onOpenChange={setDialogOpen}
          defaultName={view.name}
          projects={projects.data}
          defaultProjectId={view.suggestedProjectId}
          initialMembers={{ humans: view.initialHumans, agents: view.initialAgents }}
          onCreate={async (name, projectId, memberUserIds, memberAgentIds) => {
            await commitChannelCreate({
              data: {
                messageId: view.messageId,
                name,
                projectId,
                memberUserIds: memberUserIds ?? [],
                memberAgentIds: memberAgentIds ?? [],
              },
            });
            await refetch();
          }}
        />
      )}
      {dialogOpen && view.kind === "channel:add_member" && addMemberChannelId && (
        <ChannelAddMembersDialog
          channelId={addMemberChannelId}
          channelName={view.channel.displayName}
          open
          onOpenChange={setDialogOpen}
          proposed={{ humans: view.humans, agents: view.agents }}
          commit={{
            submit: (input) =>
              commitAddMember({
                data: { messageId: view.messageId, channelId: addMemberChannelId, ...input },
              }),
            onCommitted: () => void refetch(),
          }}
        />
      )}
      {dialogOpen && view.kind === "agent:create" && computers && (
        <AgentCreateDialog
          open
          onOpenChange={setDialogOpen}
          computers={computers}
          onLoadRuntimeCatalog={(computerId) => loadRuntimeCatalog({ data: { computerId } })}
          defaults={{
            name: view.name,
            description: view.description,
            computerId: view.requiredComputer?.id ?? view.suggestedComputer?.id,
          }}
          computerLocked={Boolean(view.requiredComputer)}
          actionCardMessageId={view.messageId}
          onCreate={(input) => create({ data: input })}
          onCreated={() => void refetch()}
        />
      )}
    </div>
  );
}
