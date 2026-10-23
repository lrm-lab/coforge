import { describe, expect, test } from "bun:test";
import {
  decodeAgentAppRegistrationRequest,
  decodeAppOwnedListResponse,
  decodeAppRegistrationStatusResponse,
  decodeAppSecretRotationResponse,
} from "./app-registration";

describe("decodeAgentAppRegistrationRequest", () => {
  test("accepts each operation with exactly its fields", () => {
    const card = "11111111-1111-4111-8111-111111111111";
    expect(decodeAgentAppRegistrationRequest({ operation: "register_status", card })).toEqual({
      operation: "register_status",
      card,
    });
    expect(
      decodeAgentAppRegistrationRequest({ operation: "register_status", client: "acme-notes" }),
    ).toEqual({ operation: "register_status", client: "acme-notes" });
    expect(decodeAgentAppRegistrationRequest({ operation: "owned_list" })).toEqual({
      operation: "owned_list",
    });
    expect(
      decodeAgentAppRegistrationRequest({ operation: "rotate_secret", clientKey: "acme-notes" }),
    ).toEqual({ operation: "rotate_secret", clientKey: "acme-notes" });
  });

  test("refuses a status with both or neither selector, and any extra field", () => {
    expect(decodeAgentAppRegistrationRequest({ operation: "register_status" })).toBeUndefined();
    expect(
      decodeAgentAppRegistrationRequest({ operation: "register_status", card: "x", client: "y" }),
    ).toBeUndefined();
    expect(
      decodeAgentAppRegistrationRequest({ operation: "owned_list", extra: 1 }),
    ).toBeUndefined();
    expect(decodeAgentAppRegistrationRequest({ operation: "rotate_secret" })).toBeUndefined();
    expect(decodeAgentAppRegistrationRequest({ operation: "nope" })).toBeUndefined();
  });
});

describe("responses", () => {
  test("a status names the card or the app", () => {
    expect(
      decodeAppRegistrationStatusResponse({ ok: true, status: "card_pending", cardMessageId: "m" }),
    ).toEqual({ ok: true, status: "card_pending", cardMessageId: "m" });
    expect(() => decodeAppRegistrationStatusResponse({ ok: true, status: "weird" })).toThrow();
  });

  test("an owned list holds pending cards and owned apps", () => {
    const body = {
      ok: true,
      pending: [{ cardMessageId: "m", name: "Acme", clientKey: null }],
      apps: [{ clientKey: "acme", name: "Acme", role: "owner" }],
    };
    expect(decodeAppOwnedListResponse(body)).toEqual(body as never);
    expect(() => decodeAppOwnedListResponse({ ok: true, pending: [] })).toThrow();
  });

  test("a rotation carries the secret once, under one name", () => {
    expect(
      decodeAppSecretRotationResponse({
        ok: true,
        clientKey: "acme",
        clientSecret: "cfa_secret_x",
      }),
    ).toEqual({ ok: true, clientKey: "acme", clientSecret: "cfa_secret_x" });
    expect(() => decodeAppSecretRotationResponse({ ok: true, clientKey: "acme" })).toThrow();
  });
});
