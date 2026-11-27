import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import {
  codexCompatibleComputerIneligibility,
  codexCompatibleComputerIneligibilityLabel,
  codexCompatibleSupportStatus,
} from "#src/features/agents/codex-compatible-computer-eligibility";
import { m } from "#src/paraglide/messages";

test("codexCompatibleSupportStatus separates supported, checking, and unsupported states", () => {
  expect(codexCompatibleSupportStatus({ data: true, isPending: false })).toBe("supported");
  expect(codexCompatibleSupportStatus({ data: undefined, isPending: true })).toBe("checking");
  expect(codexCompatibleSupportStatus({ data: false, isPending: false })).toBe("unsupported");
  expect(codexCompatibleSupportStatus(undefined)).toBe("unsupported");
});

test("codexCompatibleComputerIneligibility allows every Computer outside codex-compatible mode", () => {
  expect(
    codexCompatibleComputerIneligibility(
      { id: "c-offline", online: false, runtimes: [] },
      "unsupported",
      false,
    ),
  ).toBeUndefined();
});

test("codexCompatibleComputerIneligibility allows supported Computers and gates pending checks", () => {
  const onlineWithCodex = {
    id: "c-compat",
    online: true,
    runtimes: [{ provider: RUNTIME_PROVIDER.CODEX, unavailableCode: null }],
  };
  expect(codexCompatibleComputerIneligibility(onlineWithCodex, "supported", true)).toBeUndefined();
  expect(codexCompatibleComputerIneligibility(onlineWithCodex, "checking", true)).toBe("checking");
  expect(codexCompatibleComputerIneligibility(onlineWithCodex, undefined, true)).toBe("checking");
});

test("codexCompatibleComputerIneligibility prioritizes offline, codex_unavailable, and unsupported reasons", () => {
  expect(
    codexCompatibleComputerIneligibility(
      {
        id: "c-offline",
        online: false,
        runtimes: [{ provider: RUNTIME_PROVIDER.CODEX, unavailableCode: null }],
      },
      "unsupported",
      true,
    ),
  ).toBe("offline");

  expect(
    codexCompatibleComputerIneligibility(
      {
        id: "c-no-codex",
        online: true,
        runtimes: [{ provider: RUNTIME_PROVIDER.CLAUDE_CODE, unavailableCode: null }],
      },
      "unsupported",
      true,
    ),
  ).toBe("codex_unavailable");

  expect(
    codexCompatibleComputerIneligibility(
      {
        id: "c-unusable-codex",
        online: true,
        runtimes: [{ provider: RUNTIME_PROVIDER.CODEX, unavailableCode: "version_unsupported" }],
      },
      "unsupported",
      true,
    ),
  ).toBe("codex_unavailable");

  expect(
    codexCompatibleComputerIneligibility(
      {
        id: "c-legacy",
        online: true,
        runtimes: [{ provider: RUNTIME_PROVIDER.CODEX, unavailableCode: null }],
      },
      "unsupported",
      true,
    ),
  ).toBe("unsupported");

  expect(
    codexCompatibleComputerIneligibility(
      { id: "c-no-runtimes", online: true },
      "unsupported",
      true,
    ),
  ).toBe("unsupported");
});

test("codexCompatibleComputerIneligibilityLabel maps every reason to localized UI copy", () => {
  expect(codexCompatibleComputerIneligibilityLabel("checking")).toBe(
    m.agent_form_codex_compatible_computer_checking(),
  );
  expect(codexCompatibleComputerIneligibilityLabel("offline")).toBe(
    m.agent_form_codex_compatible_computer_offline(),
  );
  expect(codexCompatibleComputerIneligibilityLabel("codex_unavailable")).toBe(
    m.agent_form_codex_compatible_computer_codex_unavailable(),
  );
  expect(codexCompatibleComputerIneligibilityLabel("unsupported")).toBe(
    m.agent_form_codex_compatible_computer_unsupported(),
  );
});
