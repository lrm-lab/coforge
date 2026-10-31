import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  CpuChip01 as Cpu,
  Hash01 as Hash,
  Key01 as Key,
  UserPlus01 as UserPlus,
} from "@untitledui/icons";
import { Link } from "@tanstack/react-router";

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
  commitPageFillActionCard,
  denyAppGrantActionCard,
  loadActionCardStates,
} from "./action-cards.functions";
import { CreateChannelDialog } from "./create-channel-dialog";
import { ChannelAddMembersDialog } from "./channel-add-members-dialog";
import { AgentCreateDialog } from "#src/features/agents/agent-create-dialog";
import { createAgent } from "#src/features/agents/agents.functions";
import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
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
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const isPageFill = view.kind === "page:fill";
  // Known only to someone in the channel, who alone may commit (task #302).
  const addMemberChannelId = view.kind === "channel:add_member" ? view.channel.id : null;
  const [approving, setApproving] = useState(false);
  const isAppGrant = view.kind === "app:grant_agent";
  const isAppRegister = view.kind === "app:register";
  const isRecoverOwner = view.kind === "app:recover_owner";
  const create = useServerFn(createAgent);
  const loadComputers = useServerFn(listComputers);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const [computers, setComputers] = useState<Awaited<ReturnType<typeof listComputers>>>();

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

  const icon =
    view.kind === "channel:create"
      ? Hash
      : view.kind === "agent:create"
        ? Cpu
        : isPageFill || isAppGrant || isAppRegister || isRecoverOwner
          ? Key
          : UserPlus;
  const title = isPageFill
    ? m.action_card_title_page_fill()
    : view.kind === "channel:create"
      ? m.action_card_title_channel_create()
      : view.kind === "agent:create"
        ? m.action_card_title_agent_create()
        : isAppGrant
          ? m.app_card_title()
          : isAppRegister
            ? m.app_register_card_title()
            : isRecoverOwner
              ? m.app_recover_card_title()
              : m.action_card_title_add_member();
  const commitLabel = isPageFill
    ? approving
      ? m.action_card_page_fill_filling()
      : m.action_card_commit_page_fill()
    : view.kind === "channel:create"
      ? m.action_card_commit_channel_create()
      : view.kind === "agent:create"
        ? m.action_card_commit_agent_create()
        : isAppGrant
          ? approving
            ? m.app_card_approving()
            : m.agent_apps_approve()
          : isAppRegister
            ? approving
              ? m.app_register_card_committing()
              : m.app_register_card_commit()
            : isRecoverOwner
              ? approving
                ? m.app_recover_card_committing()
                : m.app_recover_card_commit()
              : m.action_card_commit_add_member();
  const deniedReason =
    view.kind === "agent:create"
      ? m.action_card_denied_agent_create()
      : view.kind === "channel:add_member"
        ? m.action_card_denied_add_member({ channel: view.channel.displayName })
        : isAppGrant
          ? m.app_card_denied_reason()
          : isAppRegister
            ? m.app_register_card_denied_reason()
            : isRecoverOwner
              ? m.app_recover_card_denied_reason()
              : isPageFill
                ? m.action_card_denied_page_fill()
                : undefined;

  const Icon = icon;
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
        {view.kind === "app:grant_agent" && (
          <>
            <p>{m.app_card_request({ app: `${view.app.name} (${view.app.key})` })}</p>
            <p className="text-tertiary">{m.app_card_scopes({ scopes: view.scopes.join(", ") })}</p>
          </>
        )}
        {view.kind === "app:recover_owner" && (
          <>
            <p>
              {m.app_recover_card_request({
                agent: view.toAgent.name,
                app: `${view.app.name} (${view.app.key})`,
              })}
            </p>
            <p className="text-tertiary">{m.app_recover_card_note()}</p>
          </>
        )}
        {view.kind === "app:register" && (
          <>
            <p>{view.app.name}</p>
            <p className="text-tertiary">
              {view.app.clientKey
                ? m.app_register_card_client_key({ key: view.app.clientKey })
                : m.app_register_card_client_key_auto()}
            </p>
            {view.app.redirectUrls.length > 0 && (
              <p className="text-tertiary break-all">
                {m.app_register_card_redirect({ urls: view.app.redirectUrls.join(", ") })}
              </p>
            )}
            {view.app.homepageUrl && (
              <p className="text-tertiary break-all">
                {m.app_register_card_homepage({ url: view.app.homepageUrl })}
              </p>
            )}
            {view.app.agentManifestUrl && (
              <p className="text-tertiary break-all">
                {m.app_register_card_manifest({ url: view.app.agentManifestUrl })}
              </p>
            )}
            {view.app.description && <p className="text-tertiary">{view.app.description}</p>}
            {view.app.whenToUse && (
              <p className="text-tertiary">
                {m.app_register_card_when_to_use({ text: view.app.whenToUse })}
              </p>
            )}
            <p className="text-tertiary">
              {m.app_register_card_category({ category: view.app.category })}
            </p>
            <p className="text-tertiary">
              {m.app_register_card_scopes({ scopes: view.app.scopes.join(", ") })}
            </p>
          </>
        )}
        {view.kind === "page:fill" && (
          <>
            {view.prompt && <p>{view.prompt}</p>}
            <p className="text-tertiary">{m.action_card_page_fill_note()}</p>
            {view.state === "pending" && view.canCommit && (
              <div className="flex flex-col gap-2 pt-1">
                {view.fields.map((field) => (
                  <label key={field.id} className="flex flex-col gap-1">
                    <span className="text-xs text-tertiary">{field.label}</span>
                    <input
                      type={field.input === "password" ? "password" : "text"}
                      autoComplete="off"
                      value={fillValues[field.id] ?? ""}
                      onChange={(event) =>
                        setFillValues((current) => ({ ...current, [field.id]: event.target.value }))
                      }
                      className="w-full rounded-md border border-secondary bg-primary px-2.5 py-1.5 text-sm text-primary outline-none"
                    />
                  </label>
                ))}
              </div>
            )}
          </>
        )}
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
                else void openDialog();
              }}
            >
              {commitLabel}
            </Button>
          ) : (
            <p className="text-xs text-tertiary">{deniedReason}</p>
          )}
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
          {view.kind === "page:fill" && view.result && (
            <>
              {" · "}
              {m.action_card_page_fill_done()}
            </>
          )}
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

      {dialogOpen && view.kind === "channel:create" && (
        <CreateChannelDialog
          open
          onOpenChange={setDialogOpen}
          defaultName={view.name}
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
