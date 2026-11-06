import { useState } from "react";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { RadioButton, RadioGroup } from "#src/components/base/radio-buttons/radio-buttons";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";

type AntigravityMethod = "oauth-personal" | "oauth-business";

/** Antigravity's `authenticate` OAuth flow opens one of two account kinds — the person picks
 * personal or business before the daemon starts it, the same way the Kiro enterprise step asks
 * for its Start URL first. */
export function AntigravitySignIn({
  onStart,
  onClose,
}: {
  onStart: (methodId: AntigravityMethod) => void;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<AntigravityMethod>("oauth-personal");
  return (
    <div className="space-y-4 p-6">
      <DialogHeader
        title={m.runtime_auth_antigravity_title()}
        description={m.runtime_auth_antigravity_hint()}
        onClose={onClose}
        className="p-0"
      />
      <RadioGroup
        aria-label={m.runtime_auth_antigravity_title()}
        value={method}
        onChange={(value) => setMethod(value as AntigravityMethod)}
        className="gap-3"
      >
        <RadioButton value="oauth-personal" label={m.runtime_auth_antigravity_personal()} />
        <RadioButton value="oauth-business" label={m.runtime_auth_antigravity_business()} />
      </RadioGroup>
      <DialogActions className="pt-1">
        <DialogCancel onPress={onClose}>{m.controls_cancel()}</DialogCancel>
        <DialogAction onPress={() => onStart(method)}>{m.runtime_auth_sign_in()}</DialogAction>
      </DialogActions>
    </div>
  );
}
