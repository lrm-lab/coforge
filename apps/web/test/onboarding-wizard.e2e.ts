import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  onNameStep,
  onSignInPage,
  openBrowser,
  personPassword,
  removeSignInAccounts,
  requireLocalServices,
  signInEmailOf,
  startSignInStack,
  type Person,
} from "./e2e-sign-in-harness";

/**
 * The first-sign-in setup wizard, against real sign-in (`e2e-sign-in-harness.ts`). The local
 * stack has no cloud cluster, so the first step offers only a local computer; the finishing
 * person gets a default cloud computer seeded (as a cluster would have made it) and walks all four
 * steps; the skipping person skips from the first. Both end in their assistant's DM with the
 * wizard gone, `onboardingPendingSince` cleared, and the role saved only by the one who chose it.
 * Whether the assistant then introduces itself needs a Daemon and is covered by the integration
 * suites (`onboarding-wizard.integration.ts`, `workspace-assistant-onboarding.integration.ts`).
 *
 * Opt-in like the other browser E2Es (`agent-browser`, `openssl`, local database and Redis); it
 * deletes what it created and leaves `summary.json` and the Web log in
 * `.amp/e2e/onboarding-wizard/`.
 *
 *   DATABASE_URL=... REDIS_URL=redis://127.0.0.1:6380 bun test ./test/onboarding-wizard.e2e.ts
 */
const { databaseUrl } = requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_ONBOARDING_WEB_PORT ?? 8797);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/onboarding-wizard");

const people = {
  finisher: {
    sub: "e2e-wiz-finisher",
    email: "e2e-wiz-finisher@coforge.test",
    name: "Wiz Finisher",
  },
  skipper: { sub: "e2e-wiz-skipper", email: "e2e-wiz-skipper@coforge.test", name: "Wiz Skipper" },
} satisfies Record<string, Person>;
type PersonKey = keyof typeof people;

test("a first sign-in lands in the setup wizard, and finishing or skipping it opens the assistant's DM", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  let stack: Awaited<ReturnType<typeof startSignInStack<PersonKey>>> | undefined;
  const finisher = openBrowser(`onboarding-wizard-finisher-${process.pid}`);
  const skipper = openBrowser(`onboarding-wizard-skipper-${process.pid}`);
  const subjects = Object.values(people).map((person) => person.sub);
  const checks: string[] = [];
  let failure: string | undefined;
  const removeSeeded = async () => {
    const identities = await db.userIdentity.findMany({
      where: { provider: "authing", providerSubject: { in: subjects } },
    });
    await db.computer.deleteMany({ where: { ownerId: { in: identities.map((i) => i.userId) } } });
    await removeSignInAccounts(db, subjects);
  };

  /** The open dialog's text, and a press on one of its buttons or radio rows by label. */
  const dialogText = `(document.querySelector('[role="dialog"]')?.innerText ?? "")`;
  const press = (label: string) =>
    `[...document.querySelectorAll('[role="dialog"] button, [role="dialog"] label')].find((element) => element.textContent.trim() === ${JSON.stringify(label)})`;
  const dialogShows = (text: string) => `${dialogText}.includes(${JSON.stringify(text)})`;

  /** Signs `key` in and answers the name step; resolves on the new Workspace, wizard open. */
  async function firstSignIn(
    who: ReturnType<typeof openBrowser>,
    key: PersonKey,
    origin: string,
  ): Promise<string> {
    await who.browser("open", `${origin}/login`);
    await who.waitFor(onSignInPage(origin));
    await who.submitSignIn(signInEmailOf(people[key]), personPassword);
    await who.waitFor(onNameStep(origin));
    await who.submitName(people[key].name);
    await who.waitFor(
      `location.origin === ${JSON.stringify(origin)} && location.pathname.startsWith("/en/w/") && ${dialogShows("Connect a Computer")}`,
    );
    return who.evaluate<string>(`location.pathname.split("/")[3]`);
  }

  try {
    stack = await startSignInStack({
      people,
      webPort,
      artifacts,
      // The Computers list reads through the Centrifugo server API; a dead endpoint is enough.
      env: {
        COFORGE_CENTRIFUGO_API_URL: "http://127.0.0.1:9/api",
        COFORGE_CENTRIFUGO_API_KEY: "x",
      },
    });
    const { origin } = stack;
    await removeSeeded();
    await mkdir(artifacts, { recursive: true });
    const userOf = async (key: PersonKey) =>
      (
        await db.userIdentity.findFirstOrThrow({
          where: { provider: "authing", providerSubject: people[key].sub },
        })
      ).userId;

    // --- Finishing: all four steps.
    const slug = await firstSignIn(finisher, "finisher", origin);
    const finisherId = await userOf("finisher");
    const workspace = await db.workspace.findUniqueOrThrow({ where: { slug } });
    expect(
      (
        await db.workspaceMemberPreference.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: finisherId } },
        })
      ).onboardingPendingSince,
    ).not.toBeNull();
    checks.push("first sign-in opens the wizard over the new Workspace and marks it pending");
    expect(await finisher.evaluate<boolean>(dialogShows("Set up your Workspace"))).toBe(true);
    // No cloud cluster here: only the local computer's install command is offered.
    expect(
      await finisher.evaluate<boolean>(dialogShows("Waiting for the computer to connect")),
    ).toBe(true);
    expect(
      await finisher.evaluate<boolean>(dialogShows("This deployment has no cloud computers")),
    ).toBe(true);
    expect(await finisher.evaluate<boolean>(dialogShows("Starting"))).toBe(false);
    checks.push("without a cloud computer its card says so and the local install command shows");

    await finisher.browser(
      "eval",
      `document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
    );
    await Bun.sleep(600);
    expect(await finisher.evaluate<boolean>(dialogShows("Connect a Computer"))).toBe(true);
    checks.push("Escape does not close the wizard");

    // What a cluster does at first sign-in: the default cloud computer, bound to the assistant.
    const assistant = await db.workspaceAssistantSession.findFirstOrThrow({
      where: { workspaceId: workspace.id, userId: finisherId },
    });
    const cloud = await db.computer.create({
      data: {
        ownerId: finisherId,
        machineId: `e2e-wiz-cloud-${process.pid}`,
        kind: "cloud",
        cloudSlot: "default",
        workspaces: { create: { workspaceId: workspace.id } },
      },
    });
    await db.agent.update({ where: { id: assistant.agentId }, data: { computerId: cloud.id } });
    await finisher.browser("screenshot", join(artifacts, "step-1-local-install.png"));
    await finisher.waitFor(dialogShows("Starting"));
    // The selection stays where the member was when the wizard opened: they pick the cloud card.
    await finisher.browser(
      "eval",
      `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes("Cloud computer")).click()`,
    );
    await finisher.browser("screenshot", join(artifacts, "step-1-cloud.png"));
    checks.push("the default cloud computer appears with its status, not a create button");
    await finisher.browser("eval", `${press("Next")}.click()`);

    await finisher.waitFor(dialogShows(`${people.finisher.name}'s Assistant`));
    expect(await finisher.evaluate<boolean>(dialogShows("Your assistant"))).toBe(true);
    checks.push("step 2 shows the assistant's own name on its card");
    await finisher.waitFor(dialogShows("Not the Computer you'll use? Start over"));
    await Bun.sleep(1500);
    await finisher.browser("screenshot", join(artifacts, "step-2-assistant.png"));
    await finisher.browser("eval", `${press("Next")}.click()`);

    await finisher.waitFor(dialogShows("What do you mainly do?"));
    await finisher.browser("eval", `${press("Designer")}.click()`);
    await finisher.browser("screenshot", join(artifacts, "step-3-role.png"));
    await finisher.browser("eval", `${press("Next")}.click()`);

    await finisher.waitFor(dialogShows("takes it from here"));
    await finisher.browser("screenshot", join(artifacts, "step-4-handoff.png"));
    await finisher.browser("eval", `${press("Let's Go")}.click()`);
    await finisher.waitFor(`/\\/dm\\/[^/]+$/.test(location.pathname)`);
    await finisher.waitFor(`!document.querySelector('[role="dialog"]')`);
    const dm = await finisher.evaluate<string>(`location.pathname.split("/").pop()`);
    const listed = await db.conversation.findUniqueOrThrow({ where: { id: dm } });
    expect(listed.directKey).toContain(assistant.agentId);
    checks.push("finishing lands in the assistant's DM with the wizard gone");
    // The chat route files the DM as the Workspace's last conversation; the wizard does not.
    await finisher.waitFor(
      `localStorage.getItem("coforge-last-conversation:${workspace.id}")?.endsWith("/dm/${dm}") === true`,
    );
    checks.push("the DM is remembered as the Workspace's last conversation");
    const after = await db.workspaceMemberPreference.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: finisherId } },
    });
    expect(after.onboardingPendingSince).toBeNull();
    expect(
      (await db.userPreference.findUniqueOrThrow({ where: { userId: finisherId } })).role,
    ).toBe("designer");
    checks.push("the mark is cleared and the chosen role is saved");

    // --- Skipping.
    const skipSlug = await firstSignIn(skipper, "skipper", origin);
    const skipperId = await userOf("skipper");
    await skipper.browser("eval", `${press("Skip Setup")}.click()`);
    await skipper.waitFor(`/\\/dm\\/[^/]+$/.test(location.pathname)`);
    await skipper.waitFor(`!document.querySelector('[role="dialog"]')`);
    const skipWorkspace = await db.workspace.findUniqueOrThrow({ where: { slug: skipSlug } });
    expect(
      (
        await db.workspaceMemberPreference.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId: skipWorkspace.id, userId: skipperId } },
        })
      ).onboardingPendingSince,
    ).toBeNull();
    expect(await db.userPreference.findUnique({ where: { userId: skipperId } })).toBeNull();
    checks.push("skipping lands in the assistant's DM, the mark cleared and no role saved");

    await skipper.browser("open", `${origin}/en/w/${skipSlug}`);
    await skipper.waitFor(`document.body.innerText.includes("general")`);
    expect(await skipper.evaluate<boolean>(`!document.querySelector('[role="dialog"]')`)).toBe(
      true,
    );
    checks.push("a reload after finishing does not open the wizard again");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await finisher.browser("close").catch(() => undefined);
    await skipper.browser("close").catch(() => undefined);
    await stack?.stop();
    await removeSeeded().catch(() => undefined);
    await db.$disconnect();
    await mkdir(artifacts, { recursive: true });
    await Bun.write(
      join(artifacts, "summary.json"),
      `${JSON.stringify(
        {
          test: "first-sign-in setup wizard (no cloud cluster)",
          command: "REDIS_URL=redis://127.0.0.1:6380 bun test ./test/onboarding-wizard.e2e.ts",
          result: failure === undefined ? "passed" : "failed",
          ...(failure === undefined ? {} : { failure }),
          checks,
        },
        null,
        2,
      )}\n`,
    );
  }
}, 600_000);
