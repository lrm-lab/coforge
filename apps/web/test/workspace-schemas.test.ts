import { describe, expect, test } from "bun:test";
import {
  createWorkspaceInputSchema,
  renameWorkspaceInputSchema,
  WORKSPACE_NAME_MAX_LENGTH,
} from "#src/features/workspaces/workspace.schemas";

describe("workspace schemas", () => {
  test("createWorkspaceInputSchema enforces WORKSPACE_NAME_MAX_LENGTH matching rename", () => {
    const valid = createWorkspaceInputSchema.safeParse({
      name: "a".repeat(WORKSPACE_NAME_MAX_LENGTH),
      slug: "valid-workspace",
    });
    expect(valid.success).toBe(true);

    const paddedValid = createWorkspaceInputSchema.safeParse({
      name: `  ${"a".repeat(WORKSPACE_NAME_MAX_LENGTH)}  `,
      slug: "valid-workspace",
    });
    expect(paddedValid.success).toBe(true);

    const tooLong = createWorkspaceInputSchema.safeParse({
      name: "a".repeat(WORKSPACE_NAME_MAX_LENGTH + 1),
      slug: "valid-workspace",
    });
    expect(tooLong.success).toBe(false);

    const renameTooLong = renameWorkspaceInputSchema.safeParse({
      name: "a".repeat(WORKSPACE_NAME_MAX_LENGTH + 1),
    });
    expect(renameTooLong.success).toBe(false);
  });
});
