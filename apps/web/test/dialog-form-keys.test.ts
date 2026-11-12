import { expect, test } from "bun:test";
import type { KeyboardEvent } from "react";

import { submitOnModEnter } from "#src/components/ui/dialog-form-keys";

/** A keydown on a form whose default button is `disabled` or not, recording what it did. */
function press(
  key: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; keyCode: number }>,
  { composing = false, disabled = false, button = true } = {},
) {
  const submitter = { disabled };
  const done = { submitted: undefined as unknown, prevented: false };
  const form = {
    querySelector: () => (button ? submitter : null),
    requestSubmit: (by: unknown) => {
      done.submitted = by;
    },
  };
  submitOnModEnter({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    keyCode: 13,
    ...key,
    nativeEvent: { isComposing: composing },
    currentTarget: form,
    preventDefault: () => {
      done.prevented = true;
    },
  } as unknown as KeyboardEvent<HTMLFormElement>);
  return { ...done, submitter };
}

test("⌘Enter and Ctrl+Enter submit through the form's default button", () => {
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
    const { submitted, prevented, submitter } = press(modifier);
    expect(submitted).toBe(submitter);
    expect(prevented).toBe(true);
  }
});

test("a plain Enter is left alone: a new line in a text area, implicit submission elsewhere", () => {
  expect(press({})).toMatchObject({ submitted: undefined, prevented: false });
  expect(press({ key: "a", metaKey: true })).toMatchObject({ submitted: undefined });
});

test("an input method's confirming Enter does not submit", () => {
  expect(press({ metaKey: true }, { composing: true })).toMatchObject({
    submitted: undefined,
    prevented: false,
  });
  expect(press({ metaKey: true, keyCode: 229 })).toMatchObject({ submitted: undefined });
});

test("a disabled default button holds the submit, as it holds implicit submission", () => {
  expect(press({ metaKey: true }, { disabled: true })).toMatchObject({
    submitted: undefined,
    prevented: true,
  });
  expect(press({ metaKey: true }, { button: false })).toMatchObject({ submitted: undefined });
});
