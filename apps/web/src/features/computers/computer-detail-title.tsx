import { useId, useRef, useState } from "react";
import { Check, Edit01 as Pencil, XClose } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { setFieldServerError, useAppForm, visibleFieldError } from "#src/components/ui/form";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import type { ComputerDetailView } from "./computer-detail-view";

export function ComputerDetailInlineTitle({
  computer,
  label,
  onUpdateDisplayName,
}: {
  computer: ComputerDetailView;
  label: string;
  onUpdateDisplayName?: (displayName: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, guard] = useSubmitGuard();
  const readContainerRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errorId = useId();
  const canEdit = computer.ownedByCurrentUser && Boolean(onUpdateDisplayName);

  const closeAndRefocus = () => {
    setEditing(false);
    queueMicrotask(() => {
      readContainerRef.current
        ?.querySelector<HTMLButtonElement>("[data-edit-computer-name]")
        ?.focus();
    });
  };

  const form = useAppForm({
    defaultValues: { displayName: computer.displayName },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current, "displayName"),
    onSubmit: async ({ value }) => {
      const trimmed = value.displayName.trim();
      if (!onUpdateDisplayName || !trimmed) return;
      await guard(async () => {
        try {
          await onUpdateDisplayName(trimmed);
          closeAndRefocus();
        } catch {
          setFieldServerError(
            form,
            "displayName",
            m.computer_display_name_error(),
            formRef.current,
          );
        }
      });
    },
  });

  const cancel = () => {
    form.reset({ displayName: computer.displayName });
    closeAndRefocus();
  };

  if (editing) {
    return (
      <form.AppForm>
        <form
          ref={formRef}
          className="relative flex min-w-0 flex-1 items-center gap-1"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || saving) return;
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.AppField name="displayName">
            {(field) => {
              const error = visibleFieldError(
                field.state.meta,
                field.form.state.submissionAttempts,
              );
              return (
                <div className="relative min-w-0 flex-1">
                  <Input
                    name={field.name}
                    aria-label={m.computer_display_name()}
                    aria-describedby={error ? errorId : undefined}
                    size="sm"
                    autoFocus
                    isRequired
                    maxLength={200}
                    value={field.state.value}
                    isDisabled={saving}
                    isInvalid={Boolean(error)}
                    onChange={(next) => {
                      if (field.state.meta.errorMap.onSubmit) {
                        field.setMeta((prev) => ({
                          ...prev,
                          errorMap: { ...prev.errorMap, onSubmit: undefined },
                        }));
                      }
                      field.handleChange(next);
                    }}
                    onBlur={field.handleBlur}
                    className="min-w-0 flex-1"
                  />
                  {error ? (
                    <p
                      id={errorId}
                      role="alert"
                      className="absolute top-full left-0 z-20 mt-1 rounded-md border border-error_subtle bg-primary px-2 py-1 text-xs text-error-primary shadow-sm"
                    >
                      {error}
                    </p>
                  ) : null}
                </div>
              );
            }}
          </form.AppField>
          <form.Subscribe selector={(state) => !state.values.displayName.trim()}>
            {(empty) => (
              <ButtonUtility
                type="submit"
                size="xs"
                color="tertiary"
                icon={Check}
                className="shrink-0"
                isDisabled={saving || empty}
                tooltip={saving ? m.computer_display_name_saving() : m.computer_display_name_save()}
              />
            )}
          </form.Subscribe>
          <ButtonUtility
            type="button"
            size="xs"
            color="tertiary"
            icon={XClose}
            className="shrink-0"
            isDisabled={saving}
            tooltip={m.computer_display_name_cancel()}
            onClick={cancel}
          />
        </form>
      </form.AppForm>
    );
  }

  return (
    <div ref={readContainerRef} className="flex min-w-0 flex-1 items-center gap-1">
      <h1 dir="auto" className="min-w-0 truncate text-sm font-semibold text-primary">
        <Tooltip title={label}>
          <TooltipTrigger className="block max-w-full min-w-0 truncate rounded-xs text-start outline-focus-ring focus-visible:outline-2">
            {label}
          </TooltipTrigger>
        </Tooltip>
      </h1>
      {canEdit ? (
        <ButtonUtility
          type="button"
          size="xs"
          color="tertiary"
          icon={Pencil}
          data-edit-computer-name=""
          className="shrink-0"
          tooltip={m.computer_display_name_edit()}
          onClick={() => {
            form.reset({ displayName: computer.displayName });
            setEditing(true);
          }}
        />
      ) : null}
    </div>
  );
}
