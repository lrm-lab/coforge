import { expect, test } from "bun:test";

import { canAutosave } from "#src/features/artifacts/artifact-autosave";

const ready = {
  dirty: true,
  loaded: true,
  readOnly: false,
  saving: false,
  failed: false,
  baseMoved: false,
  stalled: false,
};

test("unsaved edits on a writable document save by themselves", () => {
  expect(canAutosave(ready)).toBe(true);
});

test("nothing saves with nothing unsaved, before the read, read only, or mid-save", () => {
  expect(canAutosave({ ...ready, dirty: false })).toBe(false);
  expect(canAutosave({ ...ready, loaded: false })).toBe(false);
  expect(canAutosave({ ...ready, readOnly: true })).toBe(false);
  expect(canAutosave({ ...ready, saving: true })).toBe(false);
});

test("a save that stopped waits for the person rather than trying again by itself", () => {
  // Gave up on conflicts it kept meeting: still unsaved, but nothing goes until the next edit.
  expect(canAutosave({ ...ready, stalled: true })).toBe(false);
  expect(canAutosave({ ...ready, failed: true })).toBe(false);
  expect(canAutosave({ ...ready, baseMoved: true })).toBe(false);
});
