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
 * The "Connect GitHub" step after a Workspace is created, against real sign-in
 * (`e2e-sign-in-harness.ts`). The local stack configures no GitHub App, so this covers the
 * unconfigured deployment: creating the personal Workspace at `/welcome` goes through the step
 * without ever showing it and lands in the Workspace; visiting the step's URL directly passes
 * straight on to the Workspace home, or to a valid `next`, and ignores an outside `next`; a
 * Workspace the viewer is not in is a 404. The page itself (the button per status, "Skip for now")
 * needs a configured GitHub App and is not covered here.
 *
 * Opt-in like the other browser E2Es (`agent-browser`, `openssl`, local database and Redis); it
 * deletes what it created and leaves `summary.json` and the Web log in
 * `.amp/e2e/workspace-github-step/`.
 *
 *   REDIS_URL=redis://127.0.0.1:6380 bun test ./test/workspace-github-step.e2e.ts
 */
const { databaseUrl } = requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_GITHUB_STEP_WEB_PORT ?? 8796);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/workspace-github-step");

const people = {
  founder: { sub: "e2e-ghs-founder", email: "e2e-ghs-founder@coforge.test", name: "Ghs Founder" },
} satisfies Record<string, Person>;
type PersonKey = keyof typeof people;
const slug = "e2e-ghs-founder";

test("creating a Workspace passes through the GitHub step, which skips itself when GitHub is not configured", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  let stack: Awaited<ReturnType<typeof startSignInStack<PersonKey>>> | undefined;
  const { browser, evaluate, waitFor, submitName, submitSignIn } = openBrowser(
    `workspace-github-step-${process.pid}`,
  );
  const subjects = Object.values(people).map((person) => person.sub);
  const checks: string[] = [];
  let failure: string | undefined;
  const removeSeeded = () => removeSignInAccounts(db, subjects);

  try {
    stack = await startSignInStack({ people, webPort, artifacts });
    const { origin } = stack;
    const at = (path: string) =>
      `location.origin === ${JSON.stringify(origin)} && location.pathname === ${JSON.stringify(path)} && document.body.innerText.includes("general")`;
    await removeSeeded();
    await mkdir(artifacts, { recursive: true });

    await browser("open", `${origin}/login`);
    await waitFor(onSignInPage(origin));
    await submitSignIn(signInEmailOf(people.founder), personPassword);
    await waitFor(onNameStep(origin));
    await submitName("Ghs Founder");
    // The step is passed through, never shown: the person ends in the new Workspace.
    await waitFor(at(`/en/w/${slug}`));
    checks.push("first sign-in with GitHub unconfigured lands in the new Workspace");

    await browser("open", `${origin}/en/w/${slug}/connect-github`);
    await waitFor(at(`/en/w/${slug}`));
    checks.push("the step's URL passes straight on to the Workspace home");

    await browser("open", `${origin}/en/w/${slug}/connect-github?next=%2Fw%2F${slug}%2Ftasks`);
    await waitFor(
      `location.origin === ${JSON.stringify(origin)} && location.pathname === ${JSON.stringify(`/en/w/${slug}/tasks`)}`,
    );
    checks.push("a site path in next is honoured");

    await browser("open", `${origin}/en/w/${slug}/connect-github?next=https%3A%2F%2Fevil.example`);
    await waitFor(at(`/en/w/${slug}`));
    expect(await evaluate<string>("location.origin")).toBe(origin);
    checks.push("an outside next is ignored");

    await browser("open", `${origin}/en/w/not-my-workspace/connect-github`);
    await waitFor(
      `!location.pathname.endsWith("/connect-github") || document.body.innerText.length > 0`,
    );
    expect(await evaluate<boolean>(`document.body.innerText.includes("general")`)).toBe(false);
    checks.push("a Workspace the viewer is not in does not open the step");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await browser("close").catch(() => undefined);
    await stack?.stop();
    await removeSeeded().catch(() => undefined);
    await db.$disconnect();
    await mkdir(artifacts, { recursive: true });
    await Bun.write(
      join(artifacts, "summary.json"),
      `${JSON.stringify(
        {
          test: "workspace GitHub step (GitHub unconfigured)",
          command: "REDIS_URL=redis://127.0.0.1:6380 bun test ./test/workspace-github-step.e2e.ts",
          result: failure === undefined ? "passed" : "failed",
          ...(failure === undefined ? {} : { failure }),
          checks,
        },
        null,
        2,
      )}\n`,
    );
  }
}, 300_000);
