import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { AtSign } from "@untitledui/icons";
import type { LocalSessionEntry } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Alert } from "#src/components/ui/alert";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Spinner } from "#src/components/ui/spinner";
import { finishedAgentUsername, typedAgentUsername } from "#src/features/agents/agent-username";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { useWorkspaceDirectory } from "#src/features/conversations/workspace-directory-query";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { m } from "#src/paraglide/messages";
import {
  briefingFirstMessage,
  buildBriefing,
  defaultAgentName,
  freeAgentName,
  isRecentlyActive,
  shortenPath,
  truncateText,
} from "./handoff-briefing";
import type { SessionExcerptState } from "./local-session-state";
import { useHandoffCreate } from "./use-handoff-create";
import { useLocalSessionExcerpt } from "./use-local-session-handoff";

/** The working directory is in the Agent's description once; far under the description's cap. */
const DESCRIPTION_CWD_MAX = 1_000;

/**
 * The handoff dialog's second step: the chosen session, the Agent it becomes and the briefing that
 * Agent will be sent, which the person reads before anything is created.
 */
export function HandoffForm({
  computerId,
  session,
  onChooseAnother,
  onClose,
  onBusyChange,
}: {
  computerId: string;
  session: LocalSessionEntry;
  onChooseAnother: () => void;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const tool = runtimeProviderLabel(session.provider);
  const [name, setName] = useState(() => defaultAgentName(session.cwd, tool));
  const [edited, setEdited] = useState(false);
  const directory = useWorkspaceDirectory();
  // Agent names are unique in a Workspace; the ones the viewer can see are checked before submit.
  const taken = useMemo(
    () => new Set((directory.data?.agents ?? []).map((agent) => agent.handle.toLowerCase())),
    [directory.data],
  );
  const [active] = useState(() => isRecentlyActive(session.updatedAtMs, Date.now()));
  const excerpt = useLocalSessionExcerpt(computerId, session);
  const { submit, pending, error, createdName, briefingFailed } = useHandoffCreate({
    onDone: onClose,
  });
  useEffect(() => {
    onBusyChange(pending);
    return () => onBusyChange(false);
  }, [pending, onBusyChange]);

  const model = session.model.trim();
  const ready = excerpt.state.kind === "ready" ? excerpt.state.excerpt : undefined;
  const modelLabel = model || ready?.model.trim() || m.handoff_model_default();
  const briefing = buildBriefing({
    firstMessage: briefingFirstMessage(ready?.initialRequest, session.title),
    turns: ready?.recentTurns ?? [],
    roles: { user: m.handoff_role_user(), assistant: m.handoff_role_assistant() },
    render: ({ firstMessage, recent }) =>
      m.handoff_briefing({ tool, model: modelLabel, cwd: session.cwd, firstMessage, recent }),
  });

  const locked = pending || createdName !== undefined;
  // Until the person types a name, the default steps past names already taken; once the Agent
  // exists its name stays, so a resend can never be read as a second Agent.
  const shownName = createdName ?? (edited ? name : freeAgentName(name, taken));
  const username = finishedAgentUsername(shownName);
  const nameTaken = createdName === undefined && taken.has(username.toLowerCase());
  const blocked =
    excerpt.state.kind === "loading" ||
    excerpt.state.kind === "offline" ||
    excerpt.state.kind === "unsupported";
  const canSubmit = createdName !== undefined || (username !== "" && !nameTaken && !blocked);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    void submit(
      {
        name: username,
        description: m.handoff_agent_description({
          tool,
          cwd: truncateText(session.cwd, DESCRIPTION_CWD_MAX),
        }),
        provider: session.provider,
        model: model || undefined,
        computerId,
        visibility: AGENT_VISIBILITY.PUBLIC,
      },
      briefing,
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <SelectedSession session={session} onChooseAnother={onChooseAnother} disabled={locked} />
      {active && <Alert color="warning" description={m.handoff_active_warning({ tool })} />}
      <Input
        label={m.handoff_agent_name()}
        size="sm"
        icon={AtSign}
        isRequired
        hideRequiredIndicator
        isReadOnly={locked}
        value={shownName}
        isInvalid={nameTaken}
        hint={nameTaken ? m.agent_form_name_taken() : undefined}
        onChange={(text) => {
          setEdited(true);
          setName(typedAgentUsername(text));
        }}
        onBlur={() => setName(finishedAgentUsername)}
      />
      <ExcerptNotice state={excerpt.state} onRetry={excerpt.retry} />
      {excerpt.state.kind === "loading" ? (
        <Progress />
      ) : (
        !blocked && <BriefingPreview text={briefing} />
      )}
      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {error}
        </p>
      )}
      {briefingFailed && createdName !== undefined && (
        <Alert color="error" description={m.handoff_briefing_failed({ name: createdName })} />
      )}
      <DialogActions>
        <DialogCancel type="button" isDisabled={pending} onPress={onClose}>
          {m.controls_cancel()}
        </DialogCancel>
        <DialogAction
          type="submit"
          isDisabled={!canSubmit}
          isLoading={pending}
          showTextWhileLoading
        >
          {createdName !== undefined
            ? m.handoff_resend()
            : pending
              ? m.handoff_creating()
              : m.handoff_submit()}
        </DialogAction>
      </DialogActions>
    </form>
  );
}

function SelectedSession({
  session,
  onChooseAnother,
  disabled,
}: {
  session: LocalSessionEntry;
  onChooseAnother: () => void;
  disabled: boolean;
}) {
  // The session's directory and model, once: the briefing below repeats them in full.
  const place = [shortenPath(session.cwd), session.model].filter(Boolean).join(" · ");
  return (
    <div className="flex items-start gap-3 rounded-xl border border-secondary p-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-primary">
          {session.title.trim() || m.handoff_untitled()}
        </div>
        <div className="truncate text-xs text-tertiary">{place}</div>
      </div>
      <Button
        type="button"
        color="link-color"
        size="sm"
        isDisabled={disabled}
        onPress={onChooseAnother}
      >
        {m.handoff_choose_another()}
      </Button>
    </div>
  );
}

function ExcerptNotice({ state, onRetry }: { state: SessionExcerptState; onRetry: () => void }) {
  switch (state.kind) {
    case "failed":
      return <Alert color="warning" description={m.handoff_excerpt_failed()} />;
    case "busy":
      return (
        <Alert
          color="gray"
          description={m.handoff_excerpt_busy()}
          actions={<Retry onPress={onRetry} />}
        />
      );
    case "offline":
      return (
        <Alert
          color="warning"
          description={m.handoff_offline()}
          actions={<Retry onPress={onRetry} />}
        />
      );
    case "unsupported":
      return <Alert color="warning" description={m.handoff_unsupported()} />;
    default:
      return null;
  }
}

function Retry({ onPress }: { onPress: () => void }) {
  return (
    <Button type="button" color="secondary" size="sm" onPress={onPress}>
      {m.handoff_retry()}
    </Button>
  );
}

function Progress() {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-6 text-sm text-tertiary"
    >
      <Spinner className="size-4" />
      {m.handoff_loading()}
    </div>
  );
}

function BriefingPreview({ text }: { text: string }) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <p id={labelId} className="text-sm font-medium text-secondary">
        {m.handoff_briefing_preview()}
      </p>
      <div
        role="region"
        aria-labelledby={labelId}
        tabIndex={0}
        className="max-h-48 overflow-y-auto rounded-lg border border-secondary bg-secondary p-3 text-sm whitespace-pre-wrap text-secondary outline-focus-ring focus-visible:outline-2"
      >
        {text}
      </div>
    </div>
  );
}
