import { describe, expect, test } from "bun:test";
import { actionCardActionSchema, validateActionCardAction } from "./action-cards";
import { appRegisterActionSchema } from "./app-register-card";

const minimal = { type: "app:register", name: "Acme Notes" } as const;

describe("appRegisterActionSchema", () => {
  test("accepts a name alone, with every other field defaulted", () => {
    expect(appRegisterActionSchema.parse(minimal)).toEqual({
      type: "app:register",
      name: "Acme Notes",
      redirectUrls: [],
      scopes: [],
    });
  });

  test("accepts every field the card shows", () => {
    const parsed = actionCardActionSchema.parse({
      ...minimal,
      clientKey: "acme-notes",
      redirectUrls: ["https://notes.acme.example/callback"],
      homepageUrl: "https://notes.acme.example/",
      description: "Notes for the team.",
      whenToUse: "Read or write the team's notes.",
      category: "productivity",
      agentManifestUrl: "https://notes.acme.example/manifest.json",
      scopes: ["email"],
      draftHint: "Asked for in #general",
    });
    expect(parsed.type).toBe("app:register");
  });

  test("refuses an unknown field, a blank name and more than ten redirect URLs", () => {
    expect(() => appRegisterActionSchema.parse({ ...minimal, secret: "x" })).toThrow();
    expect(() => appRegisterActionSchema.parse({ ...minimal, name: " " })).toThrow();
    expect(() =>
      appRegisterActionSchema.parse({
        ...minimal,
        redirectUrls: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`),
      }),
    ).toThrow();
  });

  test("refuses duplicate redirect URLs and scopes in the cross-field rules", () => {
    const duplicate = appRegisterActionSchema.parse({
      ...minimal,
      redirectUrls: ["https://a.example/cb", "https://a.example/cb"],
    });
    expect(validateActionCardAction(duplicate)).toContain("redirect");
    const scopes = appRegisterActionSchema.parse({ ...minimal, scopes: ["email", "email"] });
    expect(validateActionCardAction(scopes)).toContain("scope");
  });
});
