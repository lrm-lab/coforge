import { useState } from "react";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import {
  parseKiroIdentityCenterOptions,
  type KiroIdentityCenterOptions,
} from "@lrm/coforge-sdk/internal";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { m } from "#src/paraglide/messages";

/** The two native IAM Identity Center inputs precede the shared runtime login progress. */
export function KiroEnterpriseSignIn({
  onStart,
  onClose,
}: {
  onStart: (target: KiroIdentityCenterOptions) => void;
  onClose: () => void;
}) {
  const [startUrl, setStartUrl] = useState("");
  const [region, setRegion] = useState("");
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        try {
          onStart(
            parseKiroIdentityCenterOptions({ startUrl: startUrl.trim(), region: region.trim() }),
          );
        } catch {
          setInvalid(true);
        }
      }}
    >
      <div className="space-y-4 p-6">
        <DialogHeader
          title={m.runtime_auth_kiro_enterprise_title()}
          onClose={onClose}
          className="p-0"
        />
        <Input
          label={m.runtime_auth_kiro_start_url()}
          value={startUrl}
          onChange={setStartUrl}
          autoComplete="off"
          spellCheck="false"
          isRequired
        />
        <Input
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
        <div className="flex justify-end gap-3 pt-1">
          <Button color="link-gray" onPress={onClose}>
            {m.controls_cancel()}
          </Button>
          <Button type="submit" isDisabled={!startUrl.trim() || !region.trim()}>
            {m.runtime_auth_sign_in()}
          </Button>
        </div>
      </div>
    </form>
  );
}
