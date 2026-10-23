import { useState } from "react";
import { XClose as X } from "@untitledui/icons";
import { Heading, RadioGroup } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { AvatarChoice } from "#src/features/profiles/avatar-choice";
import { AGENT_MASCOTS, isAgentMascot, type AgentMascot } from "./agent-mascot";
import { mascotStaticUrl } from "./mascot-contract";

const MASCOT_LABELS: Record<AgentMascot, () => string> = {
  blue: m.agent_mascot_blue,
  orange: m.agent_mascot_orange,
  pink: m.agent_mascot_pink,
  green: m.agent_mascot_green,
  purple: m.agent_mascot_purple,
  black: m.agent_mascot_black,
  yellow: m.agent_mascot_yellow,
};

/**
 * The creator's mascot picker, opened by clicking the Agent's picture in its profile: the
 * platform's mascots in a grid with the one the Agent shows now selected. Nothing is written
 * until Save; Cancel and Escape drop the choice.
 */
export function AgentAvatarDialog({
  name,
  mascot,
  open,
  onOpenChange,
  onSave,
}: {
  name: string;
  /** The mascot the Agent shows now. */
  mascot: AgentMascot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (mascot: AgentMascot) => Promise<void>;
}) {
  const [picked, setPicked] = useState<AgentMascot | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, guard] = useSubmitGuard();
  const selected = picked ?? mascot;

  function reset() {
    setPicked(null);
    setFailed(false);
  }

  function save() {
    setFailed(false);
    void guard(async () => {
      try {
        await onSave(selected);
        reset();
        onOpenChange(false);
      } catch {
        setFailed(true);
      }
    });
  }

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(nextOpen: boolean) => {
        if (busy) return;
        if (!nextOpen) reset();
        onOpenChange(nextOpen);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="overflow-hidden text-left" data-agent-avatar-dialog>
          {({ close }) => (
            <>
              <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
                <Heading slot="title" className="min-w-0 text-xl font-semibold text-primary">
                  {m.agent_avatar_dialog_title()}
                </Heading>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  isDisabled={busy}
                  onClick={close}
                />
              </div>
              <p className="mt-1 truncate px-6 text-sm text-tertiary">{name}</p>
              <RadioGroup
                aria-label={m.agent_avatar_dialog_title()}
                value={selected}
                onChange={(value) => {
                  if (isAgentMascot(value)) setPicked(value);
                }}
                isDisabled={busy}
                orientation="horizontal"
                className="mt-5 grid grid-cols-4 gap-x-3 gap-y-4 px-6"
              >
                {AGENT_MASCOTS.map((key) => (
                  <AvatarChoice
                    key={key}
                    value={key}
                    src={mascotStaticUrl(key)}
                    label={MASCOT_LABELS[key]()}
                  />
                ))}
              </RadioGroup>
              {failed && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {m.agent_avatar_save_error()}
                </p>
              )}
              <div className="mt-6 flex shrink-0 items-center justify-end gap-3 border-t border-secondary px-6 py-4">
                <Button color="secondary" isDisabled={busy} onPress={close}>
                  {m.controls_cancel()}
                </Button>
                <Button
                  isDisabled={selected === mascot || busy}
                  isLoading={busy}
                  showTextWhileLoading
                  onPress={save}
                >
                  {m.agent_avatar_save()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
