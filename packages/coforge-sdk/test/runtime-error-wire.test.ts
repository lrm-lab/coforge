import { expect, test } from "bun:test";
import {
  decodeRuntimeError,
  encodeRuntimeError,
  MAX_VISIBLE_ERROR_CHARS,
} from "../src/internal/runtime-error-action";

const failure = {
  errorClass: "BillingError",
  errorReason: "billing_exhausted",
  fingerprint: "fp-1",
};

test("the provider's words survive the wire", () => {
  const sent = { ...failure, providerMessage: "Your credit balance is too low." };
  expect(decodeRuntimeError(encodeRuntimeError(sent))).toEqual(sent);
});

test("an older daemon's frame decodes with no provider message", () => {
  expect(
    decodeRuntimeError({ ...encodeRuntimeError(failure), runtimeErrorProviderMessage: "" }),
  ).toEqual(failure);
});

test("a frame can't carry more of the provider's words than a daemon would write", () => {
  const providerMessage = "额".repeat(MAX_VISIBLE_ERROR_CHARS + 1);
  const decoded = decodeRuntimeError(encodeRuntimeError({ ...failure, providerMessage }));
  expect([...(decoded?.providerMessage ?? "")]).toHaveLength(MAX_VISIBLE_ERROR_CHARS);
});
