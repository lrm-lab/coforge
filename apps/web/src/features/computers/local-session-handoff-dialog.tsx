import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Heading } from "react-aria-components";
import { XClose as X } from "@untitledui/icons";
import type { LocalSessionEntry } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Select } from "#src/components/base/select/select";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { StatusDot } from "#src/components/ui/status-dot";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { workspacePath } from "#src/features/workspaces/workspace-url";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";
import { listComputers } from "./computers.functions";
import { HandoffForm } from "./handoff-form";
import { HandoffSessionPicker, type HandoffPickerState } from "./handoff-session-picker";
import { HandoffProgress, HandoffRefusal } from "./handoff-states";
import { sessionKey } from "./local-session-list";
import { useLocalSessionSearch } from "./use-local-session-handoff";

/**
 * "接手本机会话" from the Chat list's + menu: pick one of the viewer's own Computers, pick a Claude
 * Code or Codex session on it, then create the Agent that continues it and brief it. Closing is
 * held while the Agent is being created and briefed.
 */
export function LocalSessionHandoffDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <Modal className="w-[min(40rem,calc(100vw-2rem))]">
        <Dialog className="flex flex-col gap-5 p-6 text-left">
          <HandoffContent busy={busy} onBusyChange={setBusy} onClose={() => onOpenChange(false)} />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** Mounted with the dialog's content, so every opening starts from the Computer and the list. */
function HandoffContent({
  busy,
  onBusyChange,
  onClose,
}: {
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const workspaceId = useCurrentWorkspaceId();
  const loadComputers = useServerFn(listComputers);
  // Read each time the dialog opens: a Computer may have come online since the last look.
  const computers = useQuery({
    queryKey: ["computers", "local-session-handoff", workspaceId],
    queryFn: () => loadComputers(),
    staleTime: 0,
    gcTime: 0,
    // Not again while the dialog is open: a changed list would move the wizard to another Computer.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // A cloud Computer has no one's own sessions to hand off.
  const own = (computers.data ?? []).filter(
    (computer) => computer.ownedByCurrentUser && computer.kind !== "cloud",
  );
  const [chosenId, setChosenId] = useState<string>();
  // The one chosen, else the first that is online, else the first.
  const computerId = own.some((computer) => computer.id === chosenId)
    ? chosenId
    : (own.find((computer) => computer.online) ?? own[0])?.id;
  // The session belongs to the Computer it was picked on; another Computer drops it.
  const [picked, setPicked] = useState<{ computerId: string; session: LocalSessionEntry }>();
  const session = picked && picked.computerId === computerId ? picked.session : undefined;

  return (
    <>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <Heading slot="title" className="text-lg font-semibold text-primary">
            {m.handoff_title()}
          </Heading>
        </div>
        {!busy && (
          <ButtonUtility
            type="button"
            aria-label={m.controls_close()}
            icon={X}
            size="sm"
            color="tertiary"
            onClick={onClose}
            className="-mt-1 -mr-2 shrink-0"
          />
        )}
      </div>
      {computers.isPending ? (
        <HandoffProgress label={m.handoff_loading()} />
      ) : computers.data === undefined ? (
        <HandoffRefusal
          color="warning"
          text={m.channel_members_computers_error()}
          onRetry={() => void computers.refetch()}
        />
      ) : !computerId ? (
        <NoComputers onClose={onClose} />
      ) : (
        <>
          <Select
            size="sm"
            label={m.handoff_computer()}
            isDisabled={session !== undefined}
            selectedKey={computerId}
            onSelectionChange={(key) => {
              if (key === null) return;
              setChosenId(String(key));
            }}
          >
            {own.map((computer) => (
              <Select.Item
                key={computer.id}
                id={computer.id}
                label={computer.displayName}
                aria-label={`${computer.displayName}, ${computer.online ? m.computer_status_online() : m.computer_status_offline()}`}
                icon={
                  <StatusDot
                    tone={computer.online ? "online" : "offline"}
                    label={
                      computer.online ? m.computer_status_online() : m.computer_status_offline()
                    }
                    className="size-2"
                  />
                }
              />
            ))}
          </Select>
          <HandoffSteps
            // Another Computer has another list and search: nothing of the last one carries over.
            key={computerId}
            computerId={computerId}
            session={session}
            onSessionChange={(next) => {
              // Picking a session pins its Computer, so nothing can move the form to another.
              if (next) setChosenId(computerId);
              setPicked(next && { computerId, session: next });
            }}
            onBusyChange={onBusyChange}
            onClose={onClose}
          />
        </>
      )}
    </>
  );
}

/**
 * The wizard on one Computer. The search lives here, not in the picker, so the list it found is
 * still there when the person comes back from the form to choose another session.
 */
function HandoffSteps({
  computerId,
  session,
  onSessionChange,
  onBusyChange,
  onClose,
}: {
  computerId: string;
  session: LocalSessionEntry | undefined;
  onSessionChange: (session: LocalSessionEntry | undefined) => void;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const [picker, setPicker] = useState<HandoffPickerState>({ query: "" });
  const { state, searching, retry } = useLocalSessionSearch(computerId, picker.query);
  return session ? (
    <HandoffForm
      // Another session starts the form afresh.
      key={sessionKey(session)}
      computerId={computerId}
      session={session}
      onChooseAnother={() => onSessionChange(undefined)}
      onClose={onClose}
      onBusyChange={onBusyChange}
    />
  ) : (
    <HandoffSessionPicker
      state={state}
      searching={searching}
      onRetry={retry}
      picker={picker}
      onPickerChange={setPicker}
      onSelect={onSessionChange}
    />
  );
}

function NoComputers({ onClose }: { onClose: () => void }) {
  const workspaceSlug = useWorkspaceSlug();
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <p className="text-sm text-tertiary">{m.handoff_no_computers()}</p>
      <Button
        color="secondary"
        size="md"
        href={localizeHref(workspacePath(workspaceSlug, "/computers?add=1"))}
        onPress={onClose}
      >
        {m.agent_connect_computer()}
      </Button>
    </div>
  );
}
