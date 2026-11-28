import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { Terminal } from "@untitledui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import {
  closeComputerTerminal,
  getComputerTerminalStatus,
  setComputerTerminalEnabled,
} from "../computer-terminal.functions";
import type { ComputerTerminalStatusResult, TerminalUiStatus } from "./computer-terminal-state";
import { ComputerTerminalStatusBadge } from "./computer-terminal-status-badge";

const LazyTerminalWorkspace = lazy(() => import("./computer-terminal-workspace"));

function cardStatusBadge(
  snapshot: ComputerTerminalStatusResult | undefined,
  computerOnline: boolean,
): TerminalUiStatus | null {
  if (!snapshot) {
    return computerOnline ? null : "disconnected";
  }
  if (snapshot.unauthorized) return "unauthorized";
  if (snapshot.status === "unsupported") return "unsupported";
  if (snapshot.status === "needs_upgrade") return "needs_upgrade";
  if (snapshot.status === "disconnected") return "disconnected";
  return null;
}

export function ComputerTerminalSection({
  computerId,
  computerName,
  computerOnline,
  initialEnabled,
  platform,
}: {
  computerId: string;
  computerName: string;
  computerOnline: boolean;
  initialEnabled: boolean;
  platform: string | null;
}) {
  const desktopMode = useBreakpoint("md");
  const queryClient = useQueryClient();
  const readStatusFn = useServerFn(getComputerTerminalStatus);
  const setEnabledFn = useServerFn(setComputerTerminalEnabled);
  const closeShellFn = useServerFn(closeComputerTerminal);

  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [enableDialogOpen, setEnableDialogOpen] = useState(false);
  const [disableDialogOpen, setDisableDialogOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const closeShellActionRef = useRef<(() => Promise<void>) | null>(null);

  const queryKey = ["computer-terminal-status", computerId, computerOnline] as const;
  const { data: statusSnapshot } = useQuery({
    queryKey,
    queryFn: () => readStatusFn({ data: { computerId } }),
  });

  const refreshStatus = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["computer-terminal-status", computerId] });
  }, [computerId, queryClient]);

  const unauthorized = Boolean(statusSnapshot?.unauthorized);
  const enabled =
    statusSnapshot && !statusSnapshot.unauthorized ? statusSnapshot.enabled : initialEnabled;
  const normalizedPlatform = platform?.trim().toLowerCase() ?? "";
  const clientUnsupported = Boolean(
    normalizedPlatform && normalizedPlatform !== "darwin" && normalizedPlatform !== "linux",
  );
  const availability =
    statusSnapshot && !statusSnapshot.unauthorized
      ? statusSnapshot.status
      : clientUnsupported
        ? "unsupported"
        : computerOnline
          ? "ready"
          : "disconnected";
  const hasActiveSession =
    statusSnapshot && !statusSnapshot.unauthorized ? statusSnapshot.hasActiveSession : false;
  const badgeStatus = cardStatusBadge(statusSnapshot, computerOnline);

  const description = unauthorized
    ? m.computer_terminal_unauthorized_notice()
    : availability === "unsupported"
      ? m.computer_terminal_description_unsupported()
      : !enabled
        ? m.computer_terminal_description_disabled()
        : availability === "needs_upgrade"
          ? m.computer_terminal_description_needs_upgrade()
          : hasActiveSession
            ? m.computer_terminal_description_session_active()
            : m.computer_terminal_description_enabled();

  return (
    <section
      aria-labelledby="computer-terminal-heading"
      data-terminal-section
      className="border-b border-secondary px-page py-4 last:border-b-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 id="computer-terminal-heading" className="text-xs font-medium text-tertiary">
            {m.computer_terminal_heading()}
          </h2>
          {badgeStatus ? <ComputerTerminalStatusBadge status={badgeStatus} /> : null}
        </div>
      </div>

      <p className="mt-1.5 text-sm text-secondary wrap-anywhere">{description}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!enabled ? (
          <Button
            type="button"
            size="sm"
            color="secondary"
            iconLeading={Terminal}
            isDisabled={unauthorized || availability === "unsupported"}
            onPress={() => setEnableDialogOpen(true)}
          >
            {m.computer_terminal_enable_action()}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              color="primary"
              iconLeading={Terminal}
              isDisabled={unauthorized || availability !== "ready"}
              onPress={() => setWorkspaceOpen(true)}
            >
              {desktopMode ? m.computer_terminal_open_action() : m.computer_terminal_view_action()}
            </Button>
            {hasActiveSession ? (
              <Button
                type="button"
                size="sm"
                color="secondary-destructive"
                isDisabled={unauthorized}
                onPress={() => setCloseDialogOpen(true)}
              >
                {m.computer_terminal_close_shell_action()}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              color="secondary"
              isDisabled={unauthorized}
              onPress={() => setDisableDialogOpen(true)}
            >
              {m.computer_terminal_disable_action()}
            </Button>
          </>
        )}
      </div>

      {workspaceOpen ? (
        <Suspense fallback={null}>
          <LazyTerminalWorkspace
            open={workspaceOpen}
            computerId={computerId}
            computerName={computerName}
            onRegisterCloseShell={(handler) => {
              closeShellActionRef.current = handler;
            }}
            onRequestCloseShell={() => setCloseDialogOpen(true)}
            onOpenChange={(nextOpen) => {
              setWorkspaceOpen(nextOpen);
              if (!nextOpen) refreshStatus();
            }}
            onStatusSync={refreshStatus}
          />
        </Suspense>
      ) : null}

      <ConfirmDialog
        open={enableDialogOpen}
        onOpenChange={setEnableDialogOpen}
        title={m.computer_terminal_enable_title({ name: computerName })}
        description={m.computer_terminal_enable_description()}
        confirmLabel={m.computer_terminal_enable_confirm()}
        pendingLabel={m.computer_terminal_enable_pending()}
        errorMessage={m.computer_terminal_enable_error()}
        tone="default"
        onConfirm={async () => {
          await setEnabledFn({ data: { computerId, enabled: true } });
          setEnableDialogOpen(false);
          refreshStatus();
        }}
      />

      <ConfirmDialog
        open={disableDialogOpen}
        onOpenChange={setDisableDialogOpen}
        title={m.computer_terminal_disable_title({ name: computerName })}
        description={m.computer_terminal_disable_description()}
        confirmLabel={m.computer_terminal_disable_confirm()}
        pendingLabel={m.computer_terminal_disable_pending()}
        errorMessage={m.computer_terminal_disable_error()}
        tone="destructive"
        onConfirm={async () => {
          await setEnabledFn({ data: { computerId, enabled: false } });
          setDisableDialogOpen(false);
          setWorkspaceOpen(false);
          refreshStatus();
        }}
      />

      <ConfirmDialog
        open={closeDialogOpen}
        onOpenChange={setCloseDialogOpen}
        title={m.computer_terminal_close_title({ name: computerName })}
        description={m.computer_terminal_close_description()}
        confirmLabel={m.computer_terminal_close_confirm()}
        pendingLabel={m.computer_terminal_close_pending()}
        errorMessage={m.computer_terminal_close_error()}
        tone="destructive"
        onConfirm={async () => {
          const action = workspaceOpen ? closeShellActionRef.current : null;
          if (action) {
            await action();
          } else {
            await closeShellFn({ data: { computerId } });
          }
          setCloseDialogOpen(false);
          refreshStatus();
        }}
      />
    </section>
  );
}
