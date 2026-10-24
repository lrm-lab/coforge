import { expect, test } from "bun:test";
import { redactCredentials } from "./credential-redaction";

test("redacts an app client secret without exposing its value", () => {
  const secret = `cfa_secret_${"q".repeat(43)}`;
  expect(redactCredentials(`the secret is ${secret}`)).not.toContain(secret);
  expect(redactCredentials(`token=${secret}`)).toBe("token=[REDACTED]");
});
