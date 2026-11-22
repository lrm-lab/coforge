import { expect, test } from "bun:test";
import { saveDateTimePreferencesInputSchema as schema } from "#src/features/settings/settings.schemas";

test("updates either date-time preference without supplying or clearing the other", () => {
  for (const input of [
    { timeFormat: "24h" },
    { timeZone: "UTC" },
    { timeZone: null },
    { timeFormat: null },
    { timeZone: null, timeFormat: "12h" },
  ] as const) {
    expect(schema.parse(input)).toEqual(input);
  }
  expect(schema.safeParse({}).success).toBeFalse();
  expect(schema.safeParse({ timeFormat: "invalid" }).success).toBeFalse();
});
