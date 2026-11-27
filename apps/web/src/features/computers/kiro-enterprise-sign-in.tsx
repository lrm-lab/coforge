import { useRef } from "react";
import { useStore } from "@tanstack/react-form";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { parseKiroIdentityCenterOptions, type KiroLoginTarget } from "@lrm/coforge-sdk/internal";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { OptionCard, OptionCardGroup } from "#src/components/ui/option-card";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";

type License = KiroLoginTarget["license"];

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
  const formRef = useRef<HTMLFormElement>(null);

  const form = useAppForm({
    defaultValues: {
      license: (offerFree ? "free" : "pro") as License,
      startUrl: "",
      region: "",
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: ({ value }) => {
      if (value.license !== "pro") return onStart({ license: "free" });
      clearTargetErrors();
      const trimmedUrl = value.startUrl.trim();
      const trimmedRegion = value.region.trim();
      try {
        onStart({
          license: "pro",
          identityCenter: parseKiroIdentityCenterOptions({
            startUrl: trimmedUrl,
            region: trimmedRegion,
          }),
        });
      } catch {
        const nextField = /^https:\/\//i.test(trimmedUrl) ? "region" : "startUrl";
        setFieldServerError(form, nextField, m.runtime_auth_kiro_invalid_target(), formRef.current);
      }
    },
  });

  function clearFieldSubmitError(field: "startUrl" | "region") {
    if (!form.getFieldMeta(field)?.errorMap.onSubmit) return;
    form.setFieldMeta(field, (prev) => ({
      ...prev,
      errorMap: { ...prev.errorMap, onSubmit: undefined },
    }));
  }

  function clearTargetErrors() {
    clearFieldSubmitError("startUrl");
    clearFieldSubmitError("region");
  }

  const enterprise = useStore(form.store, (state) => state.values.license === "pro");

  return (
    <form.AppForm>
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="space-y-4 p-6">
          <DialogHeader
            title={offerFree ? m.runtime_auth_kiro_title() : m.runtime_auth_kiro_enterprise_title()}
            onClose={onClose}
            className="p-0"
          />
          {offerFree && (
            <form.AppField name="license">
              {(field) => (
                <OptionCardGroup
                  aria-label={m.runtime_auth_kiro_title()}
                  value={field.state.value}
                  onChange={(value) => {
                    field.handleChange(value as License);
                    clearTargetErrors();
                  }}
                >
                  <OptionCard
                    value="free"
                    label={m.runtime_auth_kiro_free()}
                    description={m.runtime_auth_kiro_free_hint()}
                  />
                  <OptionCard
                    value="pro"
                    label={m.runtime_auth_kiro_pro()}
                    description={m.runtime_auth_kiro_pro_hint()}
                  />
                </OptionCardGroup>
              )}
            </form.AppField>
          )}
          {enterprise && (
            <>
              <form.AppField name="startUrl">
                {(field) => (
                  <field.Input
                    size={controlSize}
                    label={m.runtime_auth_kiro_start_url()}
                    onChange={() => clearFieldSubmitError("region")}
                    autoComplete="off"
                    spellCheck="false"
                    isRequired
                  />
                )}
              </form.AppField>
              <form.AppField name="region">
                {(field) => (
                  <field.Input
                    size={controlSize}
                    label={m.runtime_auth_kiro_region()}
                    onChange={() => clearFieldSubmitError("startUrl")}
                    autoComplete="off"
                    spellCheck="false"
                    isRequired
                  />
                )}
              </form.AppField>
            </>
          )}
          <DialogActions className="pt-1">
            <DialogCancel onPress={onClose}>{m.controls_cancel()}</DialogCancel>
            <form.Subscribe
              selector={(state) =>
                state.values.license === "pro" &&
                (!state.values.startUrl.trim() || !state.values.region.trim())
              }
            >
              {(disabled) => (
                <DialogAction type="submit" isDisabled={disabled}>
                  {m.runtime_auth_sign_in()}
                </DialogAction>
              )}
            </form.Subscribe>
          </DialogActions>
        </div>
      </form>
    </form.AppForm>
  );
}
