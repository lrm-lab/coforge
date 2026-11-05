import { useState } from "react";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";

/** Antigravity's `authenticate` OAuth flow opens one of two account kinds — the person picks
 * personal or business before the daemon starts it, the same way the Kiro enterprise step asks
 * for its Start URL first. */
export function AntigravitySignIn({
  onStart,
  onClose,
}: {
  onStart: (methodId: "oauth-personal" | "oauth-business") => void;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<"oauth-personal" | "oauth-business">("oauth-personal");
  return (
    <>
      <DialogHeader title={m.runtime_auth_antigravity_title()} onClose={onClose} />
      <p className="text-sm text-tertiary">{m.runtime_auth_antigravity_hint()}</p>
      <fieldset className="flex flex-col gap-2">
        {(["oauth-personal", "oauth-business"] as const).map((id) => (
          <label key={id} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="antigravity-method"
              checked={method === id}
              onChange={() => setMethod(id)}
            />
            {id === "oauth-personal"
              ? m.runtime_auth_antigravity_personal()
              : m.runtime_auth_antigravity_business()}
          </label>
        ))}
      </fieldset>
      <DialogActions>
        <DialogCancel onPress={onClose}>{m.controls_cancel()}</DialogCancel>
        <DialogAction onPress={() => onStart(method)}>{m.runtime_auth_sign_in()}</DialogAction>
      </DialogActions>
    </>
  );
}
