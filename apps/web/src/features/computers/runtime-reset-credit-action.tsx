import { useState } from "react";
import { ClockRewind } from "@untitledui/icons";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { clearResetCreditAttempt, resetCreditAttemptKey } from "./reset-credit-attempt";
import type { ResetCreditConsumeResult } from "./use-reset-credit-consume";

/** The popover's button, an icon and the credits left, beside the sign-out icon; its name is the
 * tooltip and the accessible label. The caller shows it only for a viewer who may manage the
 * runtime, signed in, with a credit; the Computer being offline disables it. */
export function RuntimeResetCreditButton({
  available,
  computerOnline,
  onPress,
}: {
  available: number;
  computerOnline?: boolean;
  onPress: () => void;
}) {
  const label = m.runtime_reset_credit_use({ count: available });
  return (
    <Tooltip title={label}>
      <Button
        size="xs"
        color="secondary"
        iconLeading={ClockRewind}
        aria-label={label}
        isDisabled={computerOnline === false}
        className="shrink-0 tabular-nums"
        onPress={onPress}
      >
        {available}
      </Button>
    </Tooltip>
  );
}

class ResetCreditNotice extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}

/** What the person is told when the attempt did not end in a reset: what the account settled, or
 * why the Computer was not asked. */
function outcomeText(
  outcome: Exclude<ResetCreditConsumeResult, "reset" | "already_redeemed">,
  runtime: string,
): string {
  switch (outcome) {
    case "forbidden":
      return m.runtime_reset_credit_forbidden();
    case "offline":
      return m.runtime_auth_failed_offline();
    case "needs_upgrade":
      return m.runtime_reset_credit_needs_upgrade();
    case "nothing_to_reset":
      return m.runtime_reset_credit_nothing_to_reset({ runtime });
    case "no_credit":
      return m.runtime_reset_credit_no_credit();
    case "reauth_required":
      return m.runtime_reset_credit_reauth_required({ runtime });
    case "unsupported":
      return m.runtime_reset_credit_unsupported({ runtime });
    case "unknown":
      return m.runtime_reset_credit_unknown();
  }
}

/**
 * Confirms using one reset credit, naming the account and the credits left. It lives outside the
 * popover, like the sign-out dialog, so closing the popover does not unmount it. The attempt's
 * key is made when the person confirms and kept until the server settles the attempt; after
 * `unknown`, a refusal or a thrown failure a retry sends the same key, so it cannot spend a second
 * credit. `already_redeemed` means the reset went through (an earlier try of this attempt spent the
 * credit), so it ends like `reset`. Any other settled answer says so and leaves Confirm off: a new
 * press would make a new key and ask to spend again.
 */
export function RuntimeResetCreditDialog({
  computerId,
  provider,
  runtimeName,
  accountLabel,
  available,
  onConsume,
  onClose,
}: {
  computerId: string;
  provider: RuntimeProvider;
  runtimeName: string;
  /** The signed-in account as the popover names it; the runtime's name when it has none. */
  accountLabel?: string;
  available: number;
  onConsume: (idempotencyKey: string) => Promise<ResetCreditConsumeResult>;
  onClose: () => void;
}) {
  const toast = useAppToast();
  // After an unknown outcome the button asks again, with the same key.
  const [unconfirmed, setUnconfirmed] = useState(false);
  // After a settled answer that is no reset, Confirm stays off: another press would be a new attempt.
  const [ended, setEnded] = useState(false);
  const account = accountLabel ?? runtimeName;
  // The attempt is the account's on this runtime, as the popover names it.
  const attempt = accountLabel ?? "";
  const confirmLabel = unconfirmed
    ? m.runtime_reset_credit_retry()
    : m.runtime_reset_credit_confirm();
  return (
    <ConfirmDialog
      open
      tone="default"
      onOpenChange={(open) => !open && onClose()}
      title={m.runtime_reset_credit_title()}
      description={
        available > 1
          ? m.runtime_reset_credit_body({ account, runtime: runtimeName, left: available - 1 })
          : m.runtime_reset_credit_body_last({ account, runtime: runtimeName })
      }
      confirmLabel={confirmLabel}
      confirmDisabled={ended}
      pendingLabel={m.runtime_reset_credit_pending()}
      errorMessage={(cause) =>
        cause instanceof ResetCreditNotice ? cause.text : m.runtime_reset_credit_failed()
      }
      onConfirm={async () => {
        const outcome = await onConsume(resetCreditAttemptKey(computerId, provider, attempt));
        // A refusal means the Computer was not asked: the attempt stays open, key and button as
        // they were, exactly as a failed call leaves them.
        if (outcome === "forbidden" || outcome === "offline" || outcome === "needs_upgrade")
          throw new ResetCreditNotice(outcomeText(outcome, runtimeName));
        if (outcome !== "unknown") clearResetCreditAttempt(computerId, provider, attempt);
        setUnconfirmed(outcome === "unknown");
        if (outcome === "reset" || outcome === "already_redeemed") {
          toast.success(m.runtime_reset_credit_done());
          onClose();
          return;
        }
        if (outcome !== "unknown") setEnded(true);
        throw new ResetCreditNotice(outcomeText(outcome, runtimeName));
      }}
    />
  );
}
