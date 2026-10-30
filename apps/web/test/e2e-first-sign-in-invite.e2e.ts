import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { workspaceJoinLinks } from "#src/server/workspaces/join-links-store.server";
import {
  hydrated,
  onNameStep,
  onSignInPage,
  openBrowser,
  personPassword,
  removeSignInAccounts,
  requireLocalServices,
  signInEmailOf,
  signInTab,
  startSignInStack,
  type Person,
} from "./e2e-sign-in-harness";

/**
 * First sign-in through an invite link, end to end, against real sign-in (`e2e-sign-in-harness.ts`).
 *
 * - Someone who signs up from a working invite (`/join/<token>`) is asked for a display name only:
 *   no Workspace URL field, nothing made for them. Continuing returns them to the join page; joining
 *   leaves them in exactly one Workspace, the invited one.
 * - A normal sign-up (no invite) is unchanged: name and Workspace URL, and a personal Workspace.
 * - An expired invite says it is no longer available, still asks for the Workspace URL, and
 *   makes the personal Workspace.
 *
 * Opt-in like the other browser E2Es (see `e2e-first-sign-in-name.e2e.ts`); it deletes what it
 * created and leaves screenshots and `summary.json` in `.amp/e2e/first-sign-in-invite/`.
 *
 *   REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-first-sign-in-invite.e2e.ts
 */
const { databaseUrl } = requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_FIRST_SIGN_IN_INVITE_WEB_PORT ?? 8796);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/first-sign-in-invite");

const people = {
  invitee: { sub: "e2e-fsi-invitee", email: "e2e-fsi-invitee@coforge.test", name: "Ivy Invitee" },
  normal: { sub: "e2e-fsi-normal", email: "e2e-fsi-normal@coforge.test", name: "Nora Normal" },
  late: { sub: "e2e-fsi-late", email: "e2e-fsi-late@coforge.test", name: "Lena Late" },
  inviteeZh: { sub: "e2e-fsi-invitee-zh", email: "e2e-fsi-invitee-zh@coforge.test", name: "安栋" },
  lateZh: { sub: "e2e-fsi-late-zh", email: "e2e-fsi-late-zh@coforge.test", name: "迟到" },
} satisfies Record<string, Person>;
type PersonKey = keyof typeof people;

/** What differs between the two languages the invite cases run in. */
const languages = {
  en: {
    locale: "en",
    invitee: "invitee",
    late: "late",
    name: "Ivy Invitee",
    lateName: "Lena Late",
    h1: "Enter your display name",
    signIn: "Sign In",
    codeTab: "Sign in with a code",
    passwordTab: "Sign in with a password",
    continue: "Continue",
    join: (team: string) => `Join ${team}`,
    switcher: "Current workspace",
    personalSuffix: "'s Workspace",
    notice: "This invite link is no longer available. You can still create your own workspace.",
    shot: (file: string) => file,
  },
  "zh-CN": {
    locale: "zh-CN",
    invitee: "inviteeZh",
    late: "lateZh",
    name: "安栋",
    lateName: "迟到",
    h1: "输入你的昵称",
    signIn: "登录",
    codeTab: "验证码登录",
    passwordTab: "密码登录",
    continue: "继续",
    join: (team: string) => `加入 ${team}`,
    switcher: "当前工作区",
    personalSuffix: "的工作区",
    notice: "这个邀请链接已经失效。你仍然可以创建自己的工作区。",
    shot: (file: string) => file.replace(/\.png$/, ".zh-CN.png"),
  },
} as const satisfies Record<string, unknown>;

const teamSlug = "e2e-fsi-team";
const teamName = "Invite Team";
const ownerUsername = "e2e-fsi-owner";

test("a sign-up from a working invite is asked for a name only and joins without a personal Workspace", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  let stack: Awaited<ReturnType<typeof startSignInStack<PersonKey>>> | undefined;
  const { browser, evaluate, waitFor, button, submitName, submitSignIn } = openBrowser(
    `first-sign-in-invite-${process.pid}`,
  );
  const subjects = Object.values(people).map((person) => person.sub);
  const checks: string[] = [];
  const screenshots: string[] = [];
  let failure: string | undefined;
  const passed = (name: string) => checks.push(name);
  async function shoot(file: string) {
    await browser("screenshot", join(artifacts, file));
    screenshots.push(file);
  }

  const removeSeeded = async () => {
    // The invited Workspace first: joining it onboarded Agents owned by the invitees, which keep
    // their users from being deleted until the Workspace is gone.
    await db.workspace.deleteMany({ where: { slug: teamSlug } });
    await removeSignInAccounts(db, subjects);
    await db.user.deleteMany({ where: { username: ownerUsername } });
  };
  const userOf = (person: PersonKey) =>
    db.user.findFirstOrThrow({
      where: { identities: { some: { provider: "authing", providerSubject: people[person].sub } } },
    });
  const membershipsOf = async (person: PersonKey) =>
    db.workspaceMembership.findMany({
      where: { userId: (await userOf(person)).id },
      include: { workspace: true },
    });

  try {
    stack = await startSignInStack({ people, webPort, artifacts });
    const { origin } = stack;
    const onNameStepHere = onNameStep(origin);
    const fieldNames = `[...document.querySelectorAll("main input")].map((input) => input.name)`;
    const noticeText = `(document.querySelector("main form [role=status]")?.textContent ?? null)`;
    const inAppAt = (path: string) =>
      `location.origin === ${JSON.stringify(origin)} && location.pathname.includes(${JSON.stringify(path)}) && document.body.innerText.includes("general")`;
    /** Signs in from the sign-in page in `locale`, as the join page sends people there: with its
     * own path, unprefixed, as `returnTo`. */
    async function signInAs(
      person: PersonKey,
      returnTo?: string,
      language: (typeof languages)[keyof typeof languages] = languages.en,
    ) {
      const { locale } = language;
      await browser("cookies", "clear");
      await browser(
        "open",
        `${origin}${locale === "en" ? "" : `/${locale}`}/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`,
      );
      await waitFor(onSignInPage(origin, signInTab(language.codeTab)));
      await submitSignIn(
        signInEmailOf(people[person]),
        personPassword,
        language.signIn,
        signInTab(language.passwordTab),
      );
    }

    await removeSeeded();
    const owner = await db.user.create({
      data: { displayName: "Invite Owner", username: ownerUsername, welcomedAt: new Date() },
    });
    const team = await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug: teamSlug,
      name: teamName,
      userId: owner.id,
    });
    const links = workspaceJoinLinks(db);
    const newLink = () =>
      links.create({
        workspaceId: team.id,
        actorUserId: owner.id,
        maxUses: null,
        expiresAt: null,
      });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // ── An invite sign-up: the name only, then the join page, then the invited Workspace alone ──
    // Run once per language. The browser asks for English; the zh-CN run signs in from the
    // `/zh-CN` sign-in page and stays in Chinese from there on.
    async function atName(language: (typeof languages)[keyof typeof languages]) {
      expect(await evaluate<string>("location.pathname")).toBe(`/${language.locale}/welcome`);
      expect(await evaluate<string>(`document.querySelector("main h1")?.textContent`)).toBe(
        language.h1,
      );
    }
    for (const language of Object.values(languages)) {
      const link = await newLink();
      const joinPath = `/join/${link.token}`;
      const person = language.invitee;
      await signInAs(person, joinPath, language);
      await waitFor(onNameStepHere);
      await atName(language);
      expect(await evaluate<string[]>(fieldNames)).toEqual(["displayName"]);
      expect(await evaluate<string | null>(noticeText)).toBeNull();
      await shoot(language.shot("01-invite-name-only.png"));
      // Sign-in stores the provider's name; `welcomedAt` is set only when the person confirms one.
      expect((await userOf(person)).welcomedAt).toBeNull();
      await submitName(language.name, language.continue);
      await waitFor(`location.pathname === "/${language.locale}${joinPath}"`);
      const invitee = await userOf(person);
      expect(invitee.displayName).toBe(language.name);
      expect(invitee.welcomedAt).not.toBeNull();
      expect(await membershipsOf(person)).toEqual([]);
      passed(
        `[${language.locale}] an invite sign-up is asked for the name only and is sent on to the join page`,
      );

      const joinButton = button(language.join(teamName));
      await waitFor(hydrated(joinButton));
      await browser("eval", `${joinButton}.click()`);
      await waitFor(inAppAt(`/w/${teamSlug}`));
      const joined = await membershipsOf(person);
      expect(joined.map((row) => row.workspace.slug)).toEqual([teamSlug]);
      expect(joined[0]?.role).toBe("member");
      await browser("click", `[aria-label^="${language.switcher}"]`);
      await waitFor(`document.querySelectorAll("[role=menuitem]").length > 0`);
      expect(
        await evaluate<string[]>(
          `[...document.querySelectorAll("[role=menu] [role=menuitem]")].map((item) => item.textContent.trim()).filter((text) => text === ${JSON.stringify(teamName)} || text.endsWith(${JSON.stringify(language.personalSuffix)}))`,
        ),
      ).toEqual([teamName]);
      await shoot(language.shot("02-invitee-joined-switcher.png"));
      passed(`[${language.locale}] joining leaves the person in the invited Workspace only`);
    }

    // ── A normal sign-up: unchanged ─────────────────────────────────────────────────────────────
    await signInAs("normal");
    await waitFor(onNameStepHere);
    expect(await evaluate<string[]>(fieldNames)).toEqual(["displayName", "workspaceSlug"]);
    expect(await evaluate<string | null>(noticeText)).toBeNull();
    await shoot("03-normal-name-and-url.png");
    await submitName("Nora Normal");
    await waitFor(inAppAt("/w/"));
    const [personal, ...more] = await membershipsOf("normal");
    expect(more).toEqual([]);
    expect(personal?.role).toBe("owner");
    expect(personal?.workspace.name).toBe("Nora Normal's Workspace");
    passed("a normal sign-up still asks for the Workspace URL and makes the personal Workspace");

    // ── An expired invite: notice, URL field, personal Workspace ────────────────────────────────
    for (const language of Object.values(languages)) {
      const expiring = await newLink();
      await db.workspaceJoinLink.update({
        where: { id: expiring.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const joinPath = `/join/${expiring.token}`;
      const person = language.late;
      await signInAs(person, joinPath, language);
      await waitFor(onNameStepHere);
      await atName(language);
      expect(await evaluate<string | null>(noticeText)).toBe(language.notice);
      expect(await evaluate<string[]>(fieldNames)).toEqual(["displayName", "workspaceSlug"]);
      await shoot(language.shot("04-expired-invite-notice.png"));
      await submitName(language.lateName, language.continue);
      // The dead invite page is not where a new Workspace's owner goes on to: the Workspace is.
      await waitFor(inAppAt("/w/"));
      const [lates, ...rest] = await membershipsOf(person);
      expect(rest).toEqual([]);
      expect(lates?.role).toBe("owner");
      passed(
        `[${language.locale}] an expired invite says so, asks for the Workspace URL and makes the personal Workspace`,
      );
    }
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
          test: "first sign-in through an invite link",
          command:
            "REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-first-sign-in-invite.e2e.ts",
          result: failure === undefined ? "passed" : "failed",
          ...(failure === undefined ? {} : { failure }),
          checks,
          screenshots,
        },
        null,
        2,
      )}\n`,
    );
  }
}, 300_000);
