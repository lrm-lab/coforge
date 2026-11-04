import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { RUNTIME_PROVIDER_VALUES } from "@lrm/coforge-sdk/internal";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { onboardingWizard } from "#src/server/onboarding/onboarding-wizard.server";
import { PERSON_ROLES } from "./person-role";

/** What the wizard opens with, or null when the member is not in it. */
export const loadOnboardingWizard = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { db, workspaceId, user } }) => {
    declareNoStore();
    return onboardingWizard(db).state(workspaceId, user.id);
  });

/** The computers the connect step offers, each with its status and runtimes. */
export const loadOnboardingComputers = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { db, workspaceId, user } }) => {
    declareNoStore();
    return onboardingWizard(db).computers(workspaceId, user.id);
  });

/** Whether the member approved a Computer's device sign-in lately. */
export const loadDeviceApproval = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { db, user } }) => {
    declareNoStore();
    return { approved: await onboardingWizard(db).deviceApproved(user.id) };
  });

const configureInput = z.object({
  computerId: z.string().min(1).max(64),
  provider: z.enum(RUNTIME_PROVIDER_VALUES),
  model: z.string().trim().max(200),
  modelProvider: z.string().trim().max(100),
  reasoning: z.string().trim().max(50),
  fastMode: z.boolean().optional(),
});

/** Binds the member's assistant to the chosen computer and runtime; refused once it has run. */
export const configureOnboardingAssistant = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(configureInput)
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    await onboardingWizard(db).configureAssistant(workspaceId, user.id, data);
  });

/** Finishes the wizard with the member's role, or skips it with none; returns the assistant's DM. */
export const completeOnboardingWizard = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ role: z.enum(PERSON_ROLES).optional() }))
  .handler(async ({ data, context: { db, workspaceId, user } }) =>
    onboardingWizard(db).complete(workspaceId, user.id, data),
  );
