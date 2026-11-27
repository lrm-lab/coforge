import type { ComponentProps } from "react";

import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Input, type InputProps } from "#src/components/base/input/input";
import { ComboBox } from "#src/components/base/select/combobox";
import { Select } from "#src/components/base/select/select";
import { TextArea } from "#src/components/base/textarea/textarea";
import { fieldHint } from "#src/lib/form-field-error";

import { useFieldContext, useFormContext, visibleFieldError } from "./form-context";

type FieldErrorState = {
  state: {
    meta: {
      isTouched: boolean;
      errors: readonly unknown[];
      errorMap: Record<string, unknown>;
    };
  };
  form: {
    state: {
      submissionAttempts: number;
    };
  };
};

type FieldMetaSetter<TMeta extends { errorMap: Record<string, unknown> }> = {
  state: { meta: TMeta };
  setMeta: (updater: (prev: TMeta) => TMeta) => void;
};

function shownFieldError(field: FieldErrorState): string | undefined {
  return visibleFieldError(field.state.meta, field.form.state.submissionAttempts);
}

function clearSubmitError<TMeta extends { errorMap: Record<string, unknown> }>(
  field: FieldMetaSetter<TMeta>,
) {
  if (!field.state.meta.errorMap.onSubmit) return;
  field.setMeta((prev) => ({
    ...prev,
    errorMap: { ...prev.errorMap, onSubmit: undefined },
  }));
}

export function FormInput({
  hint,
  onChange,
  onBlur,
  ...props
}: Omit<InputProps, "name" | "value" | "isInvalid"> & {
  onChange?: (value: string) => void;
}) {
  const field = useFieldContext<string>();
  const error = shownFieldError(field);
  return (
    <Input
      {...props}
      name={field.name}
      value={field.state.value}
      isInvalid={Boolean(error)}
      hint={fieldHint(error, hint)}
      onChange={(next) => {
        clearSubmitError(field);
        field.handleChange(next);
        onChange?.(next);
      }}
      onBlur={(event) => {
        field.handleBlur();
        onBlur?.(event);
      }}
    />
  );
}

export function FormTextArea({
  hint,
  onChange,
  onBlur,
  ...props
}: Omit<ComponentProps<typeof TextArea>, "name" | "value" | "isInvalid"> & {
  onChange?: (value: string) => void;
}) {
  const field = useFieldContext<string>();
  const error = shownFieldError(field);
  return (
    <TextArea
      {...props}
      name={field.name}
      value={field.state.value}
      isInvalid={Boolean(error)}
      hint={fieldHint(error, hint)}
      onChange={(next) => {
        clearSubmitError(field);
        field.handleChange(next);
        onChange?.(next);
      }}
      onBlur={(event) => {
        field.handleBlur();
        onBlur?.(event);
      }}
    />
  );
}

export function FormSelect({
  hint,
  onSelectionChange,
  ...props
}: Omit<ComponentProps<typeof Select>, "name" | "selectedKey" | "isInvalid"> & {
  onSelectionChange?: (key: string) => void;
}) {
  const field = useFieldContext<string>();
  const error = shownFieldError(field);
  return (
    <div data-field={field.name} className="min-w-0">
      <Select
        {...props}
        name={field.name}
        selectedKey={field.state.value || null}
        isInvalid={Boolean(error)}
        hint={error ?? hint}
        onSelectionChange={(key) => {
          if (key === null) return;
          const next = String(key);
          clearSubmitError(field);
          field.handleChange(next);
          onSelectionChange?.(next);
        }}
      />
    </div>
  );
}

export function FormComboBox({
  hint,
  onInputChange,
  ...props
}: Omit<ComponentProps<typeof ComboBox>, "isInvalid"> & {
  onInputChange?: (value: string) => void;
}) {
  const field = useFieldContext<string>();
  const error = shownFieldError(field);
  return (
    <div data-field={field.name} className="min-w-0">
      <ComboBox
        {...props}
        inputValue={field.state.value}
        isInvalid={Boolean(error)}
        hint={error ?? hint}
        onInputChange={(next) => {
          clearSubmitError(field);
          field.handleChange(next);
          onInputChange?.(next);
        }}
      />
    </div>
  );
}

export function FormCheckbox({
  onChange,
  ...props
}: Omit<ComponentProps<typeof Checkbox>, "isSelected" | "onChange"> & {
  onChange?: (selected: boolean) => void;
}) {
  const field = useFieldContext<boolean>();
  return (
    <Checkbox
      {...props}
      isSelected={field.state.value}
      onChange={(next) => {
        clearSubmitError(field);
        field.handleChange(next);
        onChange?.(next);
      }}
    />
  );
}

export function FormAlert({ error, className }: { error?: string; className?: string }) {
  const form = useFormContext();
  return (
    <form.Subscribe selector={(state) => state.errors}>
      {(errors) => {
        const message = error || visibleFieldError({ isTouched: true, errors }, 1);
        if (!message) return null;
        return (
          <p role="alert" className={className ?? "text-sm text-error-primary"}>
            {message}
          </p>
        );
      }}
    </form.Subscribe>
  );
}
