import { RedisClient } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "#src/generated/prisma/client";

import {
  appId,
  appSecret,
  personPassword,
  refusedPassword,
  signInEmailOf,
  registeredSubFor,
  throttledDestination,
  unsendableDestination,
  startFakeAuthing,
  type Person,
  type SentCode,
} from "./e2e-fake-authing";

/**
 * What the browser e2es of real sign-in share (`e2e-sign-in-flow.e2e.ts`,
 * `e2e-first-sign-in-name.e2e.ts`): a stand-in for the part of Authing the Web server calls (the
 * v3 password and verification-code sign-in, the userinfo endpoint and token revocation) over HTTPS (a throwaway
 * self-signed certificate; the Web server trusts it through `NODE_EXTRA_CA_CERTS`, the browser
 * ignores certificate errors), a Web dev server with real sign-in (`COFORGE_DEV_SKIP_AUTH=0`)
 * pointed at it, and an `agent-browser` session that signs in through CoForge's own form. Not a
 * test file: it has no `.e2e.ts` suffix, so the e2e runner does not list it and `bun test` does
 * not run it.
 */

export {
  appId,
  appSecret,
  personPassword,
  refusedPassword,
  signInEmailOf,
  registeredSubFor,
  throttledDestination,
  unsendableDestination,
  startFakeAuthing,
};
export type { Person, SentCode };

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
export function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** A throwaway self-signed certificate for 127.0.0.1, written into `dir`. */
function writeCertificate(dir: string): { certFile: string; keyFile: string } {
  const opensslPath = Bun.which("openssl");
  if (!opensslPath) throw new Error("openssl is required");
  const certFile = join(dir, "cert.pem");
  const keyFile = join(dir, "key.pem");
  const openssl = Bun.spawnSync([
    opensslPath,
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    keyFile,
    "-out",
    certFile,
  ]);
  if (openssl.exitCode !== 0) throw new Error(`openssl failed: ${openssl.stderr.toString()}`);
  return { certFile, keyFile };
}

/**
 * Removes the accounts these e2es sign in as (found by their provider `subjects`, plus any
 * `extraUserIds`) and the Workspaces they own, whatever an earlier run left. A Workspace's owner
 * never changes, so the Workspaces owned are the ones the accounts created.
 */
export async function removeSignInAccounts(
  db: PrismaClient,
  subjects: string[],
  extraUserIds: string[] = [],
) {
  const identities = await db.userIdentity.findMany({
    where: { provider: "authing", providerSubject: { in: subjects } },
  });
  const userIds = [...identities.map((identity) => identity.userId), ...extraUserIds];
  const owned = await db.workspaceMembership.findMany({
    where: { userId: { in: userIds }, role: "owner" },
  });
  await db.workspace.deleteMany({ where: { id: { in: owned.map((row) => row.workspaceId) } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

/** The first-sign-in name step's field, as the selector `click` and `setInput` take and as the
 * page expression `evaluate` reads. */
export const nameFieldSelector = 'main input[name="displayName"]';
export const nameField = `document.querySelector(${JSON.stringify(nameFieldSelector)})`;

/** Whether a React element has hydrated: its handlers are attached, so a click will do something. */
export const hydrated = (element: string) =>
  `Object.keys(${element} ?? {}).some((key) => key.startsWith("__reactProps"))`;

/** The condition "the name step is up on `origin` and its field is ready". */
export const onNameStep = (origin: string) =>
  `location.origin === ${JSON.stringify(origin)} && location.pathname.endsWith("/welcome") && ${hydrated(nameField)}`;

/** The password form's fields, as the selector `click` and `setInput` take and as the page
 * expression `evaluate` reads. */
export const emailFieldSelector = 'main input[name="email"]';
export const passwordFieldSelector = 'main input[name="password"]';
export const emailField = `document.querySelector(${JSON.stringify(emailFieldSelector)})`;
/** The code form's fields: one for the phone number or email, one for the code. */
export const destinationFieldSelector = 'main input[name="destination"]';
export const codeFieldSelector = 'main input[name="code"]';
export const destinationField = `document.querySelector(${JSON.stringify(destinationFieldSelector)})`;
/** The sign-in page's two tabs, by their labels. */
export const signInTab = (label: string) =>
  `[...document.querySelectorAll('main [role="tab"]')].find((tab) => tab.textContent.trim() === ${JSON.stringify(label)})`;
export const codeTab = signInTab("Sign in with a code");
export const passwordTab = signInTab("Sign in with a password");

/** The condition "the sign-in page is up on `origin` and its tabs are ready". */
export const onSignInPage = (origin: string) =>
  `location.origin === ${JSON.stringify(origin)} && location.pathname.endsWith("/login") && ${hydrated(codeTab)}`;

/**
 * Forgets the sign-in attempts the Web server has counted. The limits live in Redis for 15
 * minutes (an hour for sending codes), so without this the sign-ins of one run would count against the next one's.
 */
async function clearSignInRateLimits(redisUrl: string) {
  const redis = new RedisClient(redisUrl);
  try {
    const keys = (await redis.send("KEYS", ["coforge:ratelimit:sign-in-*"])) as string[];
    if (keys.length > 0) await redis.send("DEL", keys);
  } finally {
    redis.close();
  }
}

/** The local PostgreSQL and Redis these e2es need, or a thrown error naming what is missing. */
export function requireLocalServices(): { databaseUrl: string; redisUrl: string } {
  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
    throw new Error("DATABASE_URL must target local PostgreSQL");
  // Workspace pages read Agent and Computer status from Redis.
  const redisUrl = Bun.env.REDIS_URL;
  if (!redisUrl || new URL(redisUrl).hostname !== "127.0.0.1")
    throw new Error("REDIS_URL must target local Redis");
  if (!Bun.which("agent-browser")) throw new Error("agent-browser is required");
  if (!Bun.which("openssl")) throw new Error("openssl is required");
  return { databaseUrl, redisUrl };
}

/**
 * Starts the stand-in Authing and a Web dev server signed in through it, and waits until the Web
 * server answers. `stop` ends both, removes the certificate, and writes the Web server's log to
 * `<artifacts>/web.log`.
 */
export async function startSignInStack<Key extends string>(input: {
  people: Record<Key, Person>;
  webPort: number;
  artifacts: string;
  /** The fake Authing's GitHub exchange, for a stack that signs in with GitHub. */
  github?: Parameters<typeof startFakeAuthing<Key>>[0]["github"];
  /** More environment for the Web server. */
  env?: Record<string, string>;
}) {
  const origin = `http://127.0.0.1:${input.webPort}`;
  // A server left on the port by an interrupted run would answer in place of this run's.
  if (
    await fetch(origin).then(
      () => true,
      () => false,
    )
  )
    throw new Error(`${origin} is already in use; stop it or choose another port`);

  await clearSignInRateLimits(requireLocalServices().redisUrl);
  const certDir = await mkdtemp(join(tmpdir(), "coforge-e2e-sign-in-"));
  let fake: ReturnType<typeof startFakeAuthing<Key>> | undefined;
  let web: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let webLog = "";
  const webOutput: Promise<void>[] = [];
  try {
    const { certFile, keyFile } = writeCertificate(certDir);
    fake = startFakeAuthing({
      people: input.people,
      tls: { cert: await Bun.file(certFile).text(), key: await Bun.file(keyFile).text() },
      ...(input.github ? { github: input.github } : {}),
    });
    const server = Bun.spawn(
      [
        process.execPath,
        "--bun",
        "vite",
        "dev",
        "--port",
        String(input.webPort),
        "--host",
        "127.0.0.1",
        "--strictPort",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          AUTHING_ISSUER: fake.issuer,
          AUTHING_APP_ID: appId,
          AUTHING_APP_SECRET: appSecret,
          COFORGE_DEV_SKIP_AUTH: "0",
          COFORGE_SESSION_SECRET: randomBytes(32).toString("base64url"),
          NODE_EXTRA_CA_CERTS: certFile,
          COFORGE_LOG_SERVER_ERRORS: "1",
          ...input.env,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    web = server;
    for (const stream of [server.stdout, server.stderr]) {
      webOutput.push(
        (async () => {
          const decoder = new TextDecoder();
          for await (const chunk of stream) webLog += decoder.decode(chunk, { stream: true });
        })(),
      );
    }
    await mkdir(input.artifacts, { recursive: true });

    // The Web server is up once it answers; signed out, /api/me says so.
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`Web server exited:\n${webLog}`);
      const status = await fetch(`${origin}/api/me`).then(
        (response) => response.status,
        () => 0,
      );
      if (status === 401) break;
      if (Date.now() > deadline)
        throw new Error(`Web server did not start (last status ${status}):\n${webLog}`);
      await Bun.sleep(500);
    }
  } catch (error) {
    await stopStack();
    throw error;
  }

  async function stopStack() {
    if (web) {
      web.kill();
      const stopped = await Promise.race([
        web.exited.then(() => true),
        Bun.sleep(10_000).then(() => false),
      ]);
      if (!stopped) web.kill("SIGKILL");
      await Promise.all(webOutput);
      await mkdir(input.artifacts, { recursive: true });
      await Bun.write(join(input.artifacts, "web.log"), webLog);
    }
    fake?.server.stop(true);
    await rm(certDir, { recursive: true, force: true });
    await clearSignInRateLimits(requireLocalServices().redisUrl);
  }

  return { origin, fake: fake!, stop: stopStack };
}

/** An `agent-browser` session, with the page reads and waits the sign-in e2es are written in. */
export function openBrowser(session: string) {
  const browserPath = Bun.which("agent-browser");
  if (!browserPath) throw new Error("agent-browser is required");
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      env: { ...process.env, AGENT_BROWSER_IGNORE_HTTPS_ERRORS: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  /** The tab the session is bound to, so a second tab can be left again. `tab` accepts a stable id
   * like `t1`, a label, or a CDP target id (newer `agent-browser`, which lists a `tabId`) or, in
   * older ones that list only an `index`, that position; the id is read rather than assumed. */
  async function boundTabId(): Promise<string> {
    const listed = JSON.parse(await browser("tab", "list", "--json")) as {
      data: { tabs: Array<{ active: boolean; tabId?: string; index?: number }> };
    };
    const active = listed.data.tabs.find((tab) => tab.active);
    const id = active?.tabId ?? (active?.index === undefined ? undefined : String(active.index));
    if (id === undefined) throw new Error("no active tab to return to");
    return id;
  }
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  /** Waits for a page condition, failing with the condition and the page after 20 s. */
  const waitFor = (condition: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      browser("wait", "--fn", condition).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void browser("eval", `location.href + " | " + document.body?.innerText.slice(0, 600)`)
            .catch((error: unknown) => String(error))
            .then((page) =>
              reject(new Error(`Timed out waiting for: ${condition}\nPage: ${page}`)),
            );
        }, 20_000);
      }),
    ]);
  };
  const button = (label: string) =>
    `[...document.querySelectorAll("main button, main a")].find((element) => element.textContent.trim() === ${JSON.stringify(label)})`;
  /**
   * Sets a React-controlled text field and tells React, as typing would. `agent-browser fill` sets
   * the DOM value but, for some values (an empty one), never fires the `input` event a controlled
   * field listens to, so the page keeps the old value; the native setter plus an `input` event is
   * what a keystroke leaves behind.
   */
  const setInput = (selector: string, value: string) =>
    browser(
      "eval",
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
  /** Answers the name step: sets the field, then presses its button (`Continue`, or `继续`). */
  async function submitName(displayName: string, label = "Continue") {
    await setInput(nameFieldSelector, displayName);
    await browser("eval", `${button(label)}.click()`);
  }
  /** Opens the password tab, which waits for its form, and fills it and presses its button
   * (`Sign In`, or `登录`). */
  async function submitSignIn(email: string, password: string, label = "Sign In") {
    await browser("eval", `${passwordTab}.click()`);
    await waitFor(hydrated(emailField));
    await setInput(emailFieldSelector, email);
    await setInput(passwordFieldSelector, password);
    await browser("eval", `${button(label)}.click()`);
  }
  /** On the code tab (the page's first), asks for a code for `destination`. */
  async function requestCode(destination: string) {
    await setInput(destinationFieldSelector, destination);
    await browser("eval", `${button("Send code")}.click()`);
  }
  /** On the code tab, types `code` and presses its button (`Sign In`). */
  async function submitCode(code: string) {
    await setInput(codeFieldSelector, code);
    await browser("eval", `${button("Sign In")}.click()`);
  }
  return {
    browser,
    boundTabId,
    evaluate,
    waitFor,
    button,
    setInput,
    submitName,
    submitSignIn,
    requestCode,
    submitCode,
  };
}
