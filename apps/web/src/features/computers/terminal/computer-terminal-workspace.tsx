import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Heading } from "react-aria-components";
import { Maximize02, Minimize02, RefreshCw01, Terminal, XClose } from "@untitledui/icons";
import { useServerFn } from "@tanstack/react-start";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import {
  subscribeToTokenizedRealtime,
  useBrowserRealtime,
} from "#src/features/realtime/browser-realtime";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  activateComputerTerminalAttach,
  closeComputerTerminal,
  detachComputerTerminal,
  getComputerTerminalStatus,
  prepareComputerTerminalAttach,
  refreshComputerTerminalSubscription,
  resizeComputerTerminal,
  sendComputerTerminalInput,
} from "../computer-terminal.functions";
import {
  ComputerTerminalSessionController,
  type ComputerTerminalControllerState,
} from "./computer-terminal-session-controller";
import type { TerminalNotice } from "./computer-terminal-state";
import { ComputerTerminalStatusBadge } from "./computer-terminal-status-badge";
import {
  ComputerTerminalXtermCanvas,
  type TerminalCanvasHandle,
} from "./computer-terminal-xterm-canvas";

function noticeCopy(notice: TerminalNotice): string {
  switch (notice.kind) {
    case "conflict":
      return m.computer_terminal_conflict_banner();
    case "history_unavailable":
      return m.computer_terminal_history_unavailable();
    case "output_backpressure":
      return m.computer_terminal_output_backpressure();
    case "daemon_replaced":
      return m.computer_terminal_daemon_replaced();
    case "unauthorized":
      return m.computer_terminal_unauthorized_notice();
    case "spawn_failed":
      return m.computer_terminal_spawn_failed();
    case "snapshot_gap":
      return m.computer_terminal_snapshot_gap();
    case "exited_code":
      return m.computer_terminal_exited_code({ code: String(notice.code) });
    case "exited_signal":
      return m.computer_terminal_exited_signal({ signal: notice.signal });
    default:
      return m.computer_terminal_disconnected_notice();
  }
}

function noticeToneClass(notice: TerminalNotice): string {
  switch (notice.kind) {
    case "output_backpressure":
    case "unauthorized":
    case "spawn_failed":
    case "snapshot_gap":
      return "bg-error-primary text-error-primary";
    case "conflict":
    case "history_unavailable":
    case "daemon_replaced":
      return "bg-warning-primary text-warning-primary";
    default:
      return "bg-secondary text-secondary";
  }
}

export default function ComputerTerminalWorkspace({
  open,
  computerId,
  computerName,
  onRegisterCloseShell,
  onRequestCloseShell,
  onOpenChange,
  onStatusSync,
}: {
  open: boolean;
  computerId: string;
  computerName: string;
  onRegisterCloseShell: (handler: (() => Promise<void>) | null) => void;
  onRequestCloseShell: () => void;
  onOpenChange: (open: boolean) => void;
  onStatusSync: () => void;
}) {
  const desktopMode = useBreakpoint("md");
  const mode = desktopMode ? "interactive" : "readonly";
  const realtimeClient = useBrowserRealtime();
  const [fullscreen, setFullscreen] = useState(false);
  const [canvasReadySize, setCanvasReadySize] = useState<{ cols: number; rows: number } | null>(
    null,
  );
  const [state, setState] = useState<ComputerTerminalControllerState>({
    status: "connecting",
    mode,
    shellKind: null,
    dimensions: null,
    notice: null,
  });

  const handleRef = useRef<TerminalCanvasHandle | null>(null);
  const controllerRef = useRef<ComputerTerminalSessionController | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 });
  const onStatusSyncRef = useRef(onStatusSync);
  const onRegisterCloseShellRef = useRef(onRegisterCloseShell);
  useEffect(() => {
    onStatusSyncRef.current = onStatusSync;
    onRegisterCloseShellRef.current = onRegisterCloseShell;
  });

  const prepareFn = useServerFn(prepareComputerTerminalAttach);
  const activateFn = useServerFn(activateComputerTerminalAttach);
  const refreshFn = useServerFn(refreshComputerTerminalSubscription);
  const inputFn = useServerFn(sendComputerTerminalInput);
  const resizeFn = useServerFn(resizeComputerTerminal);
  const detachFn = useServerFn(detachComputerTerminal);
  const closeFn = useServerFn(closeComputerTerminal);
  const readStatusFn = useServerFn(getComputerTerminalStatus);

  useEffect(() => {
    if (!open || !realtimeClient) return;
    const controller = new ComputerTerminalSessionController({
      computerId,
      transport: {
        prepareAttach: (data) => prepareFn({ data }),
        activateAttach: (data) => activateFn({ data }),
        refreshSubscription: (data) => refreshFn({ data }),
        sendInput: (data) => inputFn({ data }),
        resize: (data) => resizeFn({ data }),
        detach: (data) => detachFn({ data }),
        close: (data) => closeFn({ data }),
        readStatus: (data) => readStatusFn({ data }),
        subscribeTokenized: (options) => subscribeToTokenizedRealtime(realtimeClient, options),
      },
      onStateChange: (next) => {
        setState(next);
        if (next.status !== "connecting") {
          onStatusSyncRef.current();
        }
      },
      onResetOutput: () => {
        handleRef.current?.reset();
      },
      onOutput: (bytes) => {
        handleRef.current?.write(bytes);
      },
    });
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.dispose();
    };
  }, [
    activateFn,
    closeFn,
    computerId,
    detachFn,
    inputFn,
    open,
    prepareFn,
    readStatusFn,
    realtimeClient,
    refreshFn,
    resizeFn,
  ]);

  const connectWith = useCallback(
    (takeover: boolean, size?: { cols: number; rows: number }) => {
      const target = size ?? lastSizeRef.current;
      const controller = controllerRef.current;
      if (!controller) return;
      void controller.connect({
        cols: target.cols,
        rows: target.rows,
        takeover,
        mode,
      });
    },
    [mode],
  );

  useEffect(() => {
    if (!open || !realtimeClient || !canvasReadySize || !controllerRef.current) return;
    lastSizeRef.current = canvasReadySize;
    connectWith(false, canvasReadySize);
  }, [canvasReadySize, connectWith, open, realtimeClient]);

  useEffect(() => {
    onRegisterCloseShellRef.current(async () => {
      const controller = controllerRef.current;
      if (!controller) return;
      await controller.closeShell();
      onStatusSyncRef.current();
    });
    return () => {
      onRegisterCloseShellRef.current(null);
    };
  }, []);

  const handleDismiss = async () => {
    await controllerRef.current?.detach();
    onStatusSyncRef.current();
    onOpenChange(false);
  };

  const canCloseShell =
    state.status === "connecting" ||
    state.status === "connected" ||
    state.notice?.kind === "conflict";

  return (
    <ModalOverlay
      isOpen={open}
      isDismissable={mode === "readonly"}
      isKeyboardDismissDisabled={mode === "interactive"}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) void handleDismiss();
      }}
      className={
        desktopMode
          ? "items-center! justify-center! p-3! sm:p-4!"
          : "items-stretch! justify-stretch! px-0! py-0! [--modal-pb:0px]! [--modal-pt:0px]!"
      }
    >
      <Modal
        className={cn(
          "flex flex-col overflow-hidden p-0!",
          !desktopMode
            ? "h-(--app-height,100dvh) w-screen max-w-none max-h-none rounded-none!"
            : fullscreen
              ? "h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-none max-h-none"
              : "h-[min(78vh,680px)] w-[calc(100vw-3rem)] max-w-5xl max-h-none",
        )}
      >
        <Dialog className="flex min-h-0 flex-1 flex-col overflow-hidden p-0!">
          <div
            data-terminal-workspace={mode}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-secondary bg-primary px-3 py-2 sm:px-4">
              <div className="flex min-w-0 flex-1 basis-52 items-center gap-2">
                <Terminal aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
                <Heading
                  slot="title"
                  className="min-w-0 truncate text-sm font-semibold text-primary"
                >
                  {computerName}
                </Heading>
                {state.shellKind ? (
                  <span className="hidden sm:inline-flex">
                    <Badge color="gray" size="sm">
                      {state.shellKind}
                    </Badge>
                  </span>
                ) : null}
                <ComputerTerminalStatusBadge status={state.status} />
              </div>

              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {state.status === "disconnected" && state.notice?.kind !== "conflict" ? (
                  <Button
                    type="button"
                    size="xs"
                    color="secondary"
                    iconLeading={RefreshCw01}
                    className="max-md:min-h-11"
                    onPress={() => connectWith(false)}
                  >
                    {m.computer_terminal_reconnect_action()}
                  </Button>
                ) : null}
                {canCloseShell ? (
                  <Button
                    type="button"
                    size="xs"
                    color="secondary-destructive"
                    className="max-md:min-h-11"
                    onPress={onRequestCloseShell}
                  >
                    {m.computer_terminal_close_shell_action()}
                  </Button>
                ) : null}
                {desktopMode ? (
                  <ButtonUtility
                    size="sm"
                    color="tertiary"
                    tooltip={
                      fullscreen
                        ? m.computer_terminal_fullscreen_exit()
                        : m.computer_terminal_fullscreen_enter()
                    }
                    icon={fullscreen ? Minimize02 : Maximize02}
                    onClick={() => setFullscreen((current) => !current)}
                  />
                ) : null}
                <ButtonUtility
                  data-dialog-close
                  size="sm"
                  color="tertiary"
                  tooltip={m.computer_terminal_hide_action()}
                  icon={XClose}
                  className="max-md:min-h-11 max-md:min-w-11"
                  onClick={() => void handleDismiss()}
                />
              </div>
            </header>

            {mode === "readonly" ? (
              <div
                role="status"
                className="shrink-0 border-b border-secondary bg-secondary px-3 py-2 text-xs text-secondary sm:px-4"
              >
                {m.computer_terminal_readonly_banner()}
              </div>
            ) : null}

            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-terminal">
              {state.notice ? (
                <div
                  role="status"
                  className={cn(
                    "absolute inset-x-0 top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-secondary px-3 py-2 text-xs shadow-sm sm:px-4",
                    noticeToneClass(state.notice),
                  )}
                >
                  <span className="min-w-0 flex-1 wrap-anywhere">{noticeCopy(state.notice)}</span>
                  {state.notice.kind === "conflict" ? (
                    <Button
                      type="button"
                      size="xs"
                      color="primary"
                      className="shrink-0 max-md:min-h-11"
                      onPress={() => connectWith(true)}
                    >
                      {m.computer_terminal_takeover_action()}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              <Suspense fallback={<div className="min-h-0 flex-1 bg-terminal" />}>
                <ComputerTerminalXtermCanvas
                  mode={mode}
                  dimensions={state.dimensions}
                  onMountHandle={(handle) => {
                    handleRef.current = handle;
                  }}
                  onReady={(size) => {
                    lastSizeRef.current = size;
                    setCanvasReadySize(size);
                  }}
                  onResize={(size) => {
                    lastSizeRef.current = size;
                    void controllerRef.current?.resize(size.cols, size.rows);
                  }}
                  onData={(data) => {
                    controllerRef.current?.sendText(data);
                  }}
                />
              </Suspense>
            </div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
