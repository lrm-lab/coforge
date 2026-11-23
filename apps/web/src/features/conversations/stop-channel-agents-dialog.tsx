import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Text } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { TextArea } from "#src/components/base/textarea/textarea";
import { submitOnModEnter } from "#src/components/ui/dialog-form-keys";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { isAppError } from "#src/lib/app-error";
import { CHANNEL_AGENT_GUIDANCE_MAX_LENGTH } from "#src/lib/channel-agent-guidance";
import { m } from "#src/paraglide/messages";
import { resumeChannelAgents, stopChannelAgents } from "./channel-lifecycle.functions";

type Step =
  | { kind: "confirm" }
  | { kind: "stopped"; stopped: number; failed: number }
  | { kind: "resumed"; failed: number; offline: number; total: number };

type RefusalCopy = { archived: () => string; denied: () => string; error: () => string };
const STOP_REFUSALS: RefusalCopy = {
  archived: m.channel_stop_agents_archived,
  denied: m.channel_stop_agents_denied,
  error: m.channel_stop_agents_error,
};
const RESUME_REFUSALS: RefusalCopy = {
  archived: m.channel_resume_agents_archived,
  denied: m.channel_resume_agents_denied,
  error: m.channel_resume_agents_error,
};

function refusal(cause: unknown, copy: RefusalCopy) {
  const code = isAppError(cause) ? cause.code : undefined;
  return code === "CONFLICT"
    ? copy.archived()
    : code === "ACCESS_DENIED"
      ? copy.denied()
      : code === "NOT_FOUND"
        ? m.channel_stop_agents_gone()
        : copy.error();
}

/**
 * "Stop all Agents" for one channel: a confirmation, then what the stop did and, once every Agent
 * is stopped, a place to give them new guidance and resume them all with it. Stopping is not
 * permanent, so no button here is red. Mount it only while it is open, so each opening starts at
 * the confirmation.
 */
export function StopChannelAgentsDialog({
  channelId,
  channelName,
  onClose,
}: {
  channelId: string;
  channelName: string;
  onClose: () => void;
}) {
  const controlSize = useDialogControlSize();
  const stop = useServerFn(stopChannelAgents);
  const resume = useServerFn(resumeChannelAgents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState<Step>({ kind: "confirm" });
  const [guidance, setGuidance] = useState("");

  async function run(write: () => Promise<void>, copy: RefusalCopy) {
    setBusy(true);
    setError("");
    try {
      await write();
    } catch (cause) {
      setError(refusal(cause, copy));
    } finally {
      setBusy(false);
    }
  }
  const stopAll = () =>
    run(async () => {
      const { stopped, failed } = await stop({ data: { channelId } });
      setStep({ kind: "stopped", stopped, failed });
    }, STOP_REFUSALS);
  const resumeAll = () =>
    run(async () => {
      const { resumed, failed, offline } = await resume({ data: { channelId, guidance } });
      if (failed === 0 && offline === 0) onClose();
      else setStep({ kind: "resumed", failed, offline, total: resumed + failed + offline });
    }, RESUME_REFUSALS);

  const allStopped = step.kind === "stopped" && step.failed === 0;
  const guard = useUnsavedChangesGuard({
    overlayOpen: true,
    dirty: allStopped && guidance.trim() !== "",
    close: onClose,
  });
  const title =
    step.kind === "confirm"
      ? m.channel_stop_agents_title()
      : step.kind === "resumed"
        ? m.channel_resume_agents_partial_title()
        : allStopped
          ? m.channel_stop_agents_done_title()
          : m.channel_stop_agents_partial_title();
  const description =
    step.kind === "confirm"
      ? m.channel_stop_agents_confirm({ name: channelName })
      : step.kind === "resumed"
        ? [
            step.offline > 0 &&
              m.channel_resume_agents_offline({ count: step.offline, total: step.total }),
            step.failed > 0 &&
              m.channel_resume_agents_partial({ failed: step.failed, total: step.total }),
          ]
            .filter(Boolean)
            .join(" ")
        : allStopped
          ? m.channel_stop_agents_done()
          : m.channel_stop_agents_partial({
              failed: step.failed,
              total: step.stopped + step.failed,
            });

  return (
    <>
      <ModalOverlay
        confirmation={!allStopped}
        isOpen
        isDismissable={!busy}
        onOpenChange={(next) => {
          if (next || busy) return;
          guard.requestClose();
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-md">
          <Dialog className="text-left">
            {() => (
              <form
                className="contents"
                onKeyDown={submitOnModEnter}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (step.kind === "confirm") void stopAll();
                  else if (allStopped) void resumeAll();
                  else if (step.kind === "stopped") void stopAll();
                }}
              >
                <DialogHeader title={title} onClose={busy ? undefined : guard.requestClose} />
                <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                  {description}
                </Text>
                {allStopped && (
                  <div className="mx-6 mt-4 flex flex-col gap-2">
                    <p className="text-sm text-secondary">
                      {m.channel_resume_agents_guidance_hint()}
                    </p>
                    <TextArea
                      size={controlSize}
                      aria-label={m.channel_resume_agents_guidance_hint()}
                      placeholder={m.channel_resume_agents_guidance_placeholder()}
                      value={guidance}
                      onChange={setGuidance}
                      maxLength={CHANNEL_AGENT_GUIDANCE_MAX_LENGTH}
                      autoFocus
                      isDisabled={busy}
                      rows={4}
                    />
                  </div>
                )}
                {error && (
                  <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                    {error}
                  </p>
                )}
                <DialogActions className="mt-6 px-6 pb-6">
                  {step.kind === "confirm" ? (
                    <>
                      <DialogCancel isDisabled={busy} onPress={guard.requestClose}>
                        {m.channel_settings_cancel()}
                      </DialogCancel>
                      <DialogAction
                        type="submit"
                        autoFocus
                        isDisabled={busy}
                        isLoading={busy}
                        showTextWhileLoading
                      >
                        {busy ? m.channel_stop_agents_stopping() : m.channel_stop_agents_action()}
                      </DialogAction>
                    </>
                  ) : allStopped ? (
                    <>
                      <DialogCancel isDisabled={busy} onPress={guard.requestClose}>
                        {m.channel_stop_agents_keep_stopped()}
                      </DialogCancel>
                      <DialogAction
                        type="submit"
                        isDisabled={busy || !guidance.trim()}
                        isLoading={busy}
                        showTextWhileLoading
                      >
                        {busy
                          ? m.channel_resume_agents_resuming()
                          : m.channel_resume_agents_action()}
                      </DialogAction>
                    </>
                  ) : step.kind === "stopped" ? (
                    <>
                      <DialogCancel isDisabled={busy} onPress={guard.requestClose}>
                        {m.controls_close()}
                      </DialogCancel>
                      <DialogAction
                        type="submit"
                        autoFocus
                        isDisabled={busy}
                        isLoading={busy}
                        showTextWhileLoading
                      >
                        {busy ? m.channel_stop_agents_stopping() : m.channel_stop_agents_retry()}
                      </DialogAction>
                    </>
                  ) : (
                    <DialogCancel onPress={guard.requestClose}>{m.controls_close()}</DialogCancel>
                  )}
                </DialogActions>
              </form>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}
