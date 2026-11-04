import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import {
  canLeaveComputerStep,
  computerSelection,
  defaultRuntimeProvider,
  initialComputerChoice,
  localConnectionChecks,
  wizardCloudComputer,
  wizardLocalComputers,
  type WizardComputer,
} from "#src/features/onboarding/onboarding-wizard-plan";

function computer(overrides: Partial<WizardComputer> & Pick<WizardComputer, "id">): WizardComputer {
  return {
    name: overrides.id,
    displayName: "",
    kind: "local",
    cloudSlot: null,
    ownedByCurrentUser: true,
    online: true,
    runtimes: [],
    ...overrides,
  };
}

const runtime = (provider: string, unavailableCode: string | null = null) => ({
  provider: provider as WizardComputer["runtimes"][number]["provider"],
  unavailableCode: unavailableCode as WizardComputer["runtimes"][number]["unavailableCode"],
  diagnostic: null,
});

const cloud = computer({ id: "cloud", kind: "cloud", cloudSlot: "default", online: false });

test("only the member's own default cloud computer and own local computers are offered", () => {
  const theirs = computer({ id: "theirs", ownedByCurrentUser: false });
  const extra = computer({ id: "extra", kind: "cloud", cloudSlot: "extra" });
  const mine = computer({ id: "mine" });
  const all = [theirs, extra, cloud, mine];
  expect(wizardCloudComputer(all)?.id).toBe("cloud");
  expect(wizardLocalComputers(all).map((c) => c.id)).toEqual(["mine"]);
  expect(wizardCloudComputer([theirs, mine])).toBeUndefined();
});

test("a member who already owns a local computer starts on it; otherwise the cloud, else local", () => {
  expect(initialComputerChoice([cloud, computer({ id: "mine" })])).toBe("local");
  expect(initialComputerChoice([cloud])).toBe("cloud");
  expect(initialComputerChoice([])).toBe("local");
});

test("cloud needs only its computer to exist; local needs a connected computer with a usable runtime", () => {
  expect(canLeaveComputerStep("cloud", cloud)).toBe(true);
  expect(canLeaveComputerStep("cloud", undefined)).toBe(false);
  const detected = computer({ id: "mine", runtimes: [runtime(RUNTIME_PROVIDER.CODEX)] });
  expect(canLeaveComputerStep("local", detected)).toBe(true);
  expect(canLeaveComputerStep("local", undefined)).toBe(false);
  expect(canLeaveComputerStep("local", { ...detected, online: false })).toBe(false);
  expect(canLeaveComputerStep("local", computer({ id: "mine" }))).toBe(false);
  const unusable = computer({
    id: "mine",
    runtimes: [runtime(RUNTIME_PROVIDER.CODEX, "start_failed")],
  });
  expect(canLeaveComputerStep("local", unusable)).toBe(false);
});

test("the selected computer is one answer: the pick, else the one that just connected, else a usable one, else the first", () => {
  const usable = computer({ id: "usable", runtimes: [runtime(RUNTIME_PROVIDER.CODEX)] });
  const bare = computer({ id: "bare", online: false });
  const fresh = computer({ id: "fresh" });
  const selected = (
    computers: WizardComputer[],
    pickedLocalId?: string,
    choice: "cloud" | "local" = "local",
  ) =>
    computerSelection({ computers, choice, pickedLocalId, knownIds: new Set(["usable", "bare"]) })
      .selected?.id;
  expect(selected([bare, usable])).toBe("usable");
  expect(selected([bare])).toBe("bare");
  expect(selected([bare, usable, fresh])).toBe("fresh");
  // An explicit pick beats a computer that connected meanwhile.
  expect(selected([bare, usable, fresh], "bare")).toBe("bare");
  expect(selected([cloud, usable], "usable", "cloud")).toBe("cloud");
  expect(selected([usable], undefined, "cloud")).toBeUndefined();
  expect(
    computerSelection({
      computers: [bare, fresh],
      choice: "local",
      pickedLocalId: undefined,
      knownIds: new Set(["bare"]),
    }).arrived?.id,
  ).toBe("fresh");
});

test("the assistant defaults to Pi on the cloud and to the best detected runtime on a local computer", () => {
  expect(defaultRuntimeProvider("cloud", [])).toBe(RUNTIME_PROVIDER.PI);
  expect(
    defaultRuntimeProvider("local", [RUNTIME_PROVIDER.CODEX, RUNTIME_PROVIDER.CLAUDE_CODE]),
  ).toBe(RUNTIME_PROVIDER.CLAUDE_CODE);
  expect(defaultRuntimeProvider("local", [RUNTIME_PROVIDER.CODEX, RUNTIME_PROVIDER.PI])).toBe(
    RUNTIME_PROVIDER.PI,
  );
  // Any provider the picker lists is considered, the last of them included.
  expect(defaultRuntimeProvider("local", [RUNTIME_PROVIDER.DSH])).toBe(RUNTIME_PROVIDER.DSH);
  // CoForge's own runtime needs an API key, so it is never a default.
  expect(defaultRuntimeProvider("local", [RUNTIME_PROVIDER.COFORGE])).toBeUndefined();
  expect(defaultRuntimeProvider("local", [])).toBeUndefined();
});

test("the role set the survey offers is the one the database accepts", async () => {
  const { PERSON_ROLES } = await import("#src/features/onboarding/person-role");
  const sql = await Bun.file(
    new URL(
      "../prisma/migrations/20261104160001_user_preference_role_check/migration.sql",
      import.meta.url,
    ),
  ).text();
  const listed = /"role" IN \(([^)]*)\)/
    .exec(sql)?.[1]
    ?.match(/'([^']+)'/g)
    ?.map((v) => v.slice(1, -1));
  expect(listed).toEqual([...PERSON_ROLES]);
});

test("the local connection checks tick in order, and only the first pending one is current", () => {
  const statuses = (checks: { status: string }[]) => checks.map((check) => check.status);
  expect(statuses(localConnectionChecks({ approved: false, computer: undefined }))).toEqual([
    "current",
    "incomplete",
    "incomplete",
  ]);
  expect(statuses(localConnectionChecks({ approved: true, computer: undefined }))).toEqual([
    "complete",
    "current",
    "incomplete",
  ]);
  const connected = computer({ id: "mine", displayName: "MacBook" });
  // A computer that is up implies its request was approved, even if the approval was missed.
  expect(statuses(localConnectionChecks({ approved: false, computer: connected }))).toEqual([
    "complete",
    "complete",
    "current",
  ]);
  const detected = { ...connected, runtimes: [runtime(RUNTIME_PROVIDER.CLAUDE_CODE)] };
  const done = localConnectionChecks({ approved: true, computer: detected });
  expect(statuses(done)).toEqual(["complete", "complete", "complete"]);
  expect(done[1]).toMatchObject({ id: "connected", name: "MacBook" });
  expect(done[2]).toMatchObject({ id: "runtime", providers: [RUNTIME_PROVIDER.CLAUDE_CODE] });
  // Offline is not connected, and its runtimes are not counted.
  expect(
    statuses(localConnectionChecks({ approved: true, computer: { ...detected, online: false } })),
  ).toEqual(["complete", "current", "incomplete"]);
});
