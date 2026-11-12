import type { KeyboardEvent } from "react";

/**
 * A dialog form's ⌘/Ctrl+Enter (task #101): Enter in a single-line field already submits the form
 * (the browser's implicit submission), but in a multi-line field Enter starts a new line, so the
 * modifier submits from there. Put it on the `<form>`'s `onKeyDown`. It submits the way implicit
 * submission does: through the form's default button, and not while that button is disabled.
 * An input method's confirming Enter (`isComposing`, or `keyCode` 229 where Safari reports the
 * composition over before the keydown) is left to the input method.
 */
export function submitOnModEnter(event: KeyboardEvent<HTMLFormElement>) {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
  const form = event.currentTarget;
  const submitter = form.querySelector<HTMLButtonElement>("button[type=submit]");
  event.preventDefault();
  if (!submitter || submitter.disabled) return;
  form.requestSubmit(submitter);
}
