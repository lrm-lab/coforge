import { expect, test } from "bun:test";
import { mockModuleForFile } from "./helpers/file-module-mock";

await mockModuleForFile("#src/features/auth/first-sign-in.functions", () => ({
  checkWorkspaceSlug: async () => ({ available: true }),
  submitDisplayName: async () => ({ ok: true, workspaceId: "ws-1", workspaceSlug: "xiaobai" }),
  suggestWorkspaceSlug: async () => ({ slug: "xiaobai" }),
}));

const { m } = await import("#src/paraglide/messages");
const { needsServerSlugSuggestion, resolveWelcomeSubmitPayload, validateWelcomeWorkspaceSlug } =
  await import("#src/features/auth/name-step-page");

test("validateWelcomeWorkspaceSlug allows empty values and validates custom slugs", () => {
  expect(validateWelcomeWorkspaceSlug("")).toBeUndefined();
  expect(validateWelcomeWorkspaceSlug("   ")).toBeUndefined();
  expect(validateWelcomeWorkspaceSlug("my-lab")).toBeUndefined();
  expect(validateWelcomeWorkspaceSlug("Ada Lab")).toBe(m.welcome_workspace_url_invalid());
  expect(validateWelcomeWorkspaceSlug("settings")).toBe(m.welcome_workspace_url_invalid());
});

test("resolveWelcomeSubmitPayload omits workspaceSlug unless edited with a non-empty value", () => {
  expect(
    resolveWelcomeSubmitPayload({
      displayName: "小白",
      avatarPresetId: "preset-1",
      workspaceSlug: "ada",
      slugEdited: false,
      nameOnly: false,
    }),
  ).toEqual({
    displayName: "小白",
    avatarPresetId: "preset-1",
  });

  expect(
    resolveWelcomeSubmitPayload({
      displayName: "小白",
      avatarPresetId: "preset-1",
      workspaceSlug: "  my-lab ",
      slugEdited: true,
      nameOnly: false,
    }),
  ).toEqual({
    displayName: "小白",
    avatarPresetId: "preset-1",
    workspaceSlug: "my-lab",
  });

  expect(
    resolveWelcomeSubmitPayload({
      displayName: "小白",
      avatarPresetId: "preset-1",
      workspaceSlug: "   ",
      slugEdited: true,
      nameOnly: false,
    }),
  ).toEqual({
    displayName: "小白",
    avatarPresetId: "preset-1",
  });

  expect(
    resolveWelcomeSubmitPayload({
      displayName: "Ada",
      avatarPresetId: "preset-1",
      workspaceSlug: "ignored",
      slugEdited: true,
      nameOnly: true,
      returnTo: "/join/abc",
    }),
  ).toEqual({
    displayName: "Ada",
    avatarPresetId: "preset-1",
    returnTo: "/join/abc",
  });
});

test("needsServerSlugSuggestion triggers for Han, non-ASCII, and reserved names only", () => {
  expect(needsServerSlugSuggestion("小白")).toBe(true);
  expect(needsServerSlugSuggestion("小白 AI")).toBe(true);
  expect(needsServerSlugSuggestion("✨")).toBe(true);
  expect(needsServerSlugSuggestion("admin")).toBe(true);
  expect(needsServerSlugSuggestion("")).toBe(false);
  expect(needsServerSlugSuggestion("   ")).toBe(false);
  expect(needsServerSlugSuggestion("Ada Lovelace")).toBe(false);
});
