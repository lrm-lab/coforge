import { expect, test } from "bun:test";
import { parseArgs, run, type ReminderResponse } from "../index";
import { CliError } from "#src/cli-error";

const reminderId = "123e4567-e89b-42d3-a456-426614174000";

const transport = (reminder: (request: { operation: string }) => ReminderResponse) => ({
  check: async () => ({ messages: [] }),
  read: async () => undefined,
  send: async () => undefined,
  view: async () => ({ bytes: new Uint8Array() }),
  reminder: async (request: { operation: string }) => reminder(request),
});

const listing = (reminders: unknown[]) => () => ({
  accepted: true,
  reminders,
  events: [],
});

test("seal and unseal parse their own flag sets", () => {
  expect(
    parseArgs(["reminder", "seal", "--id", reminderId, "--owner", "@ada", "--until", "x"]),
  ).toMatchObject({
    operation: "seal",
    reminderId,
    owner: "@ada",
    until: "x",
  });
  expect(
    parseArgs([
      "reminder",
      "seal",
      "--id",
      reminderId,
      "--all-pending",
      "--owner",
      "@ada",
      "--until",
      "x",
    ]),
  ).toMatchObject({ allPending: true });
  expect(parseArgs(["reminder", "unseal", "--id", reminderId, "--revision", "3"])).toMatchObject({
    operation: "unseal",
    revision: 3,
  });
});

test("seal refuses both selectors at once, a missing owner, and an owner on unseal", () => {
  expect(() =>
    parseArgs([
      "reminder",
      "seal",
      "--id",
      reminderId,
      "--revision",
      "3",
      "--all-pending",
      "--owner",
      "@ada",
      "--until",
      "x",
    ]),
  ).toThrow("Pass at most one of --revision and --all-pending");
  expect(() => parseArgs(["reminder", "seal", "--id", reminderId, "--until", "x"])).toThrow(
    "Sealing a reminder needs --owner and --until",
  );
  expect(() => parseArgs(["reminder", "unseal", "--id", reminderId, "--owner", "@ada"])).toThrow();
});

test("seal prints how many source identities it sealed, and unseal how many it released", async () => {
  const sealed = await run(
    ["reminder", "seal", "--id", reminderId, "--owner", "@ada", "--until", "the deploy lands"],
    transport(() => ({
      accepted: true,
      reminderId,
      sealed: 1,
      owner: "@ada",
      until: "the deploy lands",
    })),
  );
  expect(sealed).toBe(
    "Sealed 1 reminder source identity for 123e4567 by @ada until the deploy lands.",
  );

  const unsealed = await run(
    ["reminder", "unseal", "--id", reminderId, "--all-pending"],
    transport(() => ({ accepted: true, reminderId, sealed: 2 })),
  );
  expect(unsealed).toBe("Unsealed 2 reminder source identities for 123e4567.");
});

test("an unseal with no matching seal is NOT_FOUND", async () => {
  const error = await run(
    ["reminder", "unseal", "--id", reminderId],
    transport(() => ({ accepted: false, reason: "no-matching-seal", reminderId })),
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("NOT_FOUND");
  expect((error as CliError).message).toBe("No matching local reminder seal exists");
});

test("a sealed reminder's cancel is UPDATE_FAILED and names the unseal", async () => {
  const error = await run(
    ["reminder", "cancel", "--id", reminderId],
    transport(() => ({
      accepted: false,
      reason: "sealed",
      owner: "@ada",
      until: "the deploy lands",
      reminderId,
    })),
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("UPDATE_FAILED");
  expect((error as CliError).message).toBe(
    "sealed by @ada until the deploy lands; run coforge reminder unseal explicitly first",
  );
});

test("an ambiguous --id prefix is INVALID_ARG for a seal, not a second lookup", async () => {
  const other = "123e4567-e89b-42d3-a456-426614174999";
  const error = await run(
    ["reminder", "seal", "--id", "123e4567", "--owner", "@ada", "--until", "x"],
    transport(
      listing([
        { reminderId, version: 1, status: "scheduled" },
        { reminderId: other, version: 1, status: "scheduled" },
      ]),
    ),
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("INVALID_ARG");
  expect((error as CliError).message).toBe("Reminder prefix 123e4567 is ambiguous");
});
