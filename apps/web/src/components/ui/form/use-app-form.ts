import { createFormHook } from "@tanstack/react-form";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";

import { fieldContext, formContext } from "./form-context";
import {
  FormAlert,
  FormCheckbox,
  FormComboBox,
  FormInput,
  FormSelect,
  FormTextArea,
} from "./form-fields";

export const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    Input: FormInput,
    TextArea: FormTextArea,
    Select: FormSelect,
    ComboBox: FormComboBox,
    Checkbox: FormCheckbox,
  },
  formComponents: {
    Alert: FormAlert,
  },
});

type FieldMetaLike = {
  isTouched: boolean;
  errorMap: Record<string, unknown>;
};

export function setFieldServerError<
  TField extends string,
  TMeta extends FieldMetaLike = FieldMetaLike,
>(
  form: {
    setFieldMeta: (field: TField, updater: (prev: TMeta) => TMeta) => void;
  },
  field: TField,
  message: string,
  container?: ParentNode | null,
): void {
  form.setFieldMeta(field, (prev) => ({
    ...prev,
    isTouched: true,
    errorMap: { ...prev.errorMap, onSubmit: message },
  }));
  if (container) scheduleFocusInvalidField(container, field);
}
