import { useState } from "react";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { parseKiroIdentityCenterOptions, type KiroLoginTarget } from "@lrm/coforge-sdk/internal";
import { Input } from "#src/components/base/input/input";
import { RadioButton, RadioGroup } from "#src/components/base/radio-buttons/radio-buttons";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";

type License = KiroLoginTarget["license"];

/**
 * What precedes the shared runtime login progress for Kiro. A Computer that can sign Kiro in free
 * (`offerFree`, task #87) asks which account first, free (Builder ID, Google, GitHub) chosen, and
 * the two IAM Identity Center inputs open under Enterprise only; one that cannot asks for those
 * two inputs alone, as it always has.
 */
export function KiroEnterpriseSignIn({
  offerFree,
  onStart,
  onClose,
}: {
  offerFree: boolean;
  onStart: (target: KiroLoginTarget) => void;
  onClose: () => void;
}) {
  const controlSize = useDialogControlSize();
  const [license, setLicense] = useState<License>(offerFree ? "free" : "pro");
  const [startUrl, setStartUrl] = useState("");
  const [region, setRegion] = useState("");
  const [invalid, setInvalid] = useState(false);
  const enterprise = license === "pro";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!enterprise) return onStart({ license: "free" });
        try {
          onStart({
            license: "pro",
            identityCenter: parseKiroIdentityCenterOptions({
              startUrl: startUrl.trim(),
              region: region.trim(),
            }),
          });
        } catch {
          setInvalid(true);
        }
      }}
    >
      <div className="space-y-4 p-6">
        <DialogHeader
          title={offerFree ? m.runtime_auth_kiro_title() : m.runtime_auth_kiro_enterprise_title()}
          onClose={onClose}
          className="p-0"
        />
        {offerFree && (
          <RadioGroup
            aria-label={m.runtime_auth_kiro_title()}
            value={license}
            onChange={(value) => setLicense(value as License)}
            className="gap-3"
          >
            <RadioButton
              value="free"
              label={m.runtime_auth_kiro_free()}
              hint={m.runtime_auth_kiro_free_hint()}
            />
            <RadioButton
              value="pro"
              label={m.runtime_auth_kiro_pro()}
              hint={m.runtime_auth_kiro_pro_hint()}
            />
          </RadioGroup>
        )}
        {enterprise && (
          <>
            <Input
              size={controlSize}
              label={m.runtime_auth_kiro_start_url()}
              value={startUrl}
              onChange={setStartUrl}
              autoComplete="off"
              spellCheck="false"
              isRequired
            />
            <Input
              size={controlSize}
              label={m.runtime_auth_kiro_region()}
              value={region}
              onChange={setRegion}
              autoComplete="off"
              spellCheck="false"
              isRequired
            />
            {invalid && (
              <p role="alert" className="text-sm text-error-primary">
                {m.runtime_auth_kiro_invalid_target()}
              </p>
            )}
          </>
        )}
        <DialogActions className="pt-1">
          <DialogCancel onPress={onClose}>{m.controls_cancel()}</DialogCancel>
          <DialogAction
            type="submit"
            isDisabled={enterprise && (!startUrl.trim() || !region.trim())}
          >
            {m.runtime_auth_sign_in()}
          </DialogAction>
        </DialogActions>
      </div>
    </form>
  );
}
