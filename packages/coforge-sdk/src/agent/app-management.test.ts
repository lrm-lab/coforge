import { describe, expect, test } from "bun:test";
import { actionCardActionSchema } from "./action-cards";
import {
  decodeAppDeletedResponse,
  decodeAppManagedResponse,
  decodeAppOwnerTransferResponse,
  decodeAppPublishRequestResponse,
  decodeAppShareLinkCreatedResponse,
  decodeAppShareLinkRevokedResponse,
  decodeAppShareLinkStatusResponse,
} from "./app-management";
import { decodeAgentAppRegistrationRequest as decode } from "./app-registration";

const clientKey = "acme-notes";

describe("management requests", () => {
  test("accept each operation with exactly its fields", () => {
    const changes = { name: "Acme", homepageUrl: null, scopes: [] };
    expect(decode({ operation: "update", clientKey, changes })).toEqual({
      operation: "update",
      clientKey,
      changes,
    });
    const logo = {
      operation: "logo_set",
      clientKey,
      contentType: "image/png",
      dataBase64: "AA==",
    } as const;
    expect(decode(logo)).toEqual(logo);
    expect(decode({ operation: "transfer_owner", clientKey, toAgent: "bob" })).toEqual({
      operation: "transfer_owner",
      clientKey,
      toAgent: "bob",
    });
    expect(decode({ operation: "share_link_create", clientKey, expiresDays: 7 })).toEqual({
      operation: "share_link_create",
      clientKey,
      expiresDays: 7,
    });
    for (const operation of [
      "logo_clear",
      "delete",
      "share_link_status",
      "share_link_revoke",
      "request_publish",
      "request_unpublish",
    ])
      expect(decode({ operation, clientKey })).toEqual({ operation, clientKey } as never);
  });

  test("refuse extra, missing and malformed fields", () => {
    expect(decode({ operation: "delete", clientKey, extra: 1 })).toBeUndefined();
    expect(decode({ operation: "delete" })).toBeUndefined();
    expect(decode({ operation: "update", clientKey, changes: {} })).toBeUndefined();
    expect(decode({ operation: "update", clientKey, changes: { key: "x" } })).toBeUndefined();
    expect(decode({ operation: "update", clientKey, changes: { name: 1 } })).toBeUndefined();
    expect(
      decode({
        operation: "update",
        clientKey,
        changes: { redirectUrls: ["https://a.example/"], addRedirectUrls: ["https://b.example/"] },
      }),
    ).toBeUndefined();
    expect(decode({ operation: "transfer_owner", clientKey })).toBeUndefined();
    for (const expiresDays of [0, 366, 1.5, "7"])
      expect(decode({ operation: "share_link_create", clientKey, expiresDays })).toBeUndefined();
    expect(decode({ operation: "logo_set", clientKey, contentType: "image/png" })).toBeUndefined();
  });
});

describe("management responses", () => {
  test("decode each shape and refuse a malformed one", () => {
    const app = {
      clientKey,
      name: "Acme",
      description: "",
      whenToUse: "",
      category: "other",
      homepageUrl: null,
      redirectUrls: [],
      agentManifestUrl: null,
      scopes: ["openid"],
      hasLogo: false,
      publishStatus: "private",
    };
    expect(decodeAppManagedResponse({ ok: true, app }).app.clientKey).toBe(clientKey);
    expect(() => decodeAppManagedResponse({ ok: true, app: { ...app, hasLogo: 1 } })).toThrow();
    expect(
      decodeAppOwnerTransferResponse({
        ok: true,
        clientKey,
        changed: true,
        ownerAgent: "bob",
        previousOwnerAgent: null,
        at: "2026-10-23T00:00:00.000Z",
      }).changed,
    ).toBe(true);
    expect(decodeAppDeletedResponse({ ok: true, clientKey, deleted: true }).deleted).toBe(true);
    expect(() => decodeAppDeletedResponse({ ok: true, clientKey, deleted: false })).toThrow();
    expect(
      decodeAppShareLinkCreatedResponse({
        ok: true,
        clientKey,
        url: "https://x.example/apps/share/t",
        createdAt: "a",
        expiresAt: "b",
      }).url,
    ).toContain("/apps/share/");
    expect(decodeAppShareLinkStatusResponse({ ok: true, clientKey, active: false }).active).toBe(
      false,
    );
    expect(decodeAppShareLinkRevokedResponse({ ok: true, clientKey, revoked: true }).revoked).toBe(
      true,
    );
    expect(
      decodeAppPublishRequestResponse({ ok: true, clientKey, publishStatus: "publish_requested" })
        .publishStatus,
    ).toBe("publish_requested");
    expect(() => decodeAppPublishRequestResponse({ ok: false })).toThrow();
  });
});

describe("app:recover_owner card", () => {
  test("takes the app and the Agent", () => {
    expect(
      actionCardActionSchema.parse({ type: "app:recover_owner", clientKey, toAgent: "bob" }),
    ).toEqual({ type: "app:recover_owner", clientKey, toAgent: "bob" });
    expect(() => actionCardActionSchema.parse({ type: "app:recover_owner", clientKey })).toThrow();
  });
});
