import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { RUNTIME_PROVIDER_DISPLAY_ORDER } from "#src/features/agents/runtime-provider-display";

// `RUNTIME_PROVIDER_DISPLAY_ORDER` is a plain array, so the compiler cannot force every
// RuntimeProvider value into it the way `Record<RuntimeProvider, ...>` forces the label and mark
// tables. This test is that check instead: CoForge is offered by the runtime picker separately
// from this list (it is always shown). DSH is intentionally hidden until its native/account/UI
// acceptance slice; the list must hold exactly every other exposed provider value.
test("RUNTIME_PROVIDER_DISPLAY_ORDER lists exposed runtimes while pending DSH stays hidden", () => {
  const expected = Object.values(RUNTIME_PROVIDER).filter(
    (provider) => provider !== RUNTIME_PROVIDER.COFORGE && provider !== RUNTIME_PROVIDER.DSH,
  );
  expect([...RUNTIME_PROVIDER_DISPLAY_ORDER].sort()).toEqual([...expected].sort());
});
