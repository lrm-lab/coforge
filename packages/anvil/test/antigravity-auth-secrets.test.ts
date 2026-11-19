import { expect, test } from "bun:test";
import { extractAntigravityAuthSecrets } from "#src/antigravity/auth-terminal";

test("registers full callback URL, raw code query token, and percent-decoded code for redaction", () => {
  const pasted =
    "http://localhost:43123/oauth2callback?state=xyz&code=4%2F0A-secret_code%2B1&scope=openid";
  expect(extractAntigravityAuthSecrets(pasted)).toEqual([
    pasted,
    "4%2F0A-secret_code%2B1",
    "4/0A-secret_code+1",
  ]);
});

test("handles plain authorization codes and URLs without a code query parameter", () => {
  expect(extractAntigravityAuthSecrets("4/0A-plain-code")).toEqual(["4/0A-plain-code"]);
  const noCode = "http://localhost:43123/oauth2callback?state=xyz";
  expect(extractAntigravityAuthSecrets(noCode)).toEqual([noCode]);
});
