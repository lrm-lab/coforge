import { expect, test } from "bun:test";
import * as neutral from "@lrm/coforge-anvil";

test("DSH is available through its named public entry while root stays neutral", async () => {
  const runtime = await import("@lrm/coforge-anvil/dsh");
  expect(typeof runtime.DshProvider).toBe("function");
  expect(runtime.DSH_ACP_VERSION).toBe("0.2.1-rc.2");
  expect(typeof runtime.discoverDshCatalog).toBe("function");
  expect("DshProvider" in neutral).toBe(false);
  expect("DSH_INSTRUCTIONS_PLUGIN" in neutral).toBe(false);
});
