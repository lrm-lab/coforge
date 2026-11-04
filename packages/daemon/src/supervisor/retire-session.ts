import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  computerCredentialFilename,
  resolveComputerCredentialsDirectory,
} from "@lrm/coforge-sdk/internal";
import type { ComputerSelfClient } from "#src/connection/computer-self-client";
import type { DaemonCredentialStore } from "#src/credentials/credential-store";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "supervisor"]);

/**
 * `retire-session` (task #417 step 3): once a Workspace daemon reports started, the machine
 * retires the user login its setup left on it — about twenty seconds on, so a start that
 * crashes at once does not retire the login a retry still wants. The Bearer is that login,
 * `x-coforge-computer-key` the Workspace's own `sk_computer`; the server retires only a login
 * of its own device login and refuses a browser token outright.
 *
 * The local `user-session` file goes only on a definite answer — `retired` or
 * `already_retired` — read once more after the call so a login the operator just rewrote
 * never gets removed underneath them. A retryable answer waits the ten-minute retry; a
 * third failure leaves the file and logs, so the login is retried on a later start.
 */
const RETIRE_DELAY_MS = 20_000;
const RETIRE_RETRY_MS = 10 * 60_000;

/** Bun's `sleep` takes no signal; this settles on the delay or the abort, whichever is first.
 * `unref` keeps a long retry delay from holding the Coordinator process open. */
const sleep = (ms: number, signal?: AbortSignal, unref = false) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (unref) timer.unref();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** The Computer's credentials directory — the same resolution the Computer's own
 * `FileCredentialStore` uses (`COFORGE_COMPUTER_CREDENTIALS_DIR`, `COFORGE_COMPUTER_HOME`, then
 * the platform default), shared with the SDK so the daemon picks the same file the setup
 * wrote (task #417). */
function computerCredentialsDirectory(environment: Record<string, string | undefined>): string {
  return resolveComputerCredentialsDirectory({
    platform: process.platform,
    homeDirectory: homedir(),
    environment,
  });
}

/** The login the setup left is the one credential file the Computer's `FileCredentialStore`
 * keeps for its server — `<hostname>[-<port>].json`, exactly `FileCredentialStore.pathFor`'s
 * naming, so a staging login beside a production one is never picked by mistake. */
async function loginSessionFile(
  directory: string,
  serverHttpUrl: string,
): Promise<{ path: string; contents: string } | null> {
  let filename: string;
  try {
    filename = computerCredentialFilename(serverHttpUrl);
  } catch {
    return null;
  }
  const path = join(directory, filename);
  try {
    return { path, contents: await readFile(path, "utf8") };
  } catch {
    return null;
  }
}

export async function retireComputerSessionOnce(
  deps: {
    selfClient: Pick<ComputerSelfClient, "retireSession">;
    credentials: Pick<DaemonCredentialStore, "load">;
    workspaceId: string;
    computerId: string;
    /** The attached server — names which login file this retire is for. */
    serverHttpUrl: string;
    /** The Computer's credentials directory — where the setup's login file lives. */
    credentialsDirectory?: string;
    environment?: Record<string, string | undefined>;
  },
  signal?: AbortSignal,
): Promise<{ retired: true } | { retired: false; reason: string }> {
  const directory =
    deps.credentialsDirectory ?? computerCredentialsDirectory(deps.environment ?? process.env);
  const session = await loginSessionFile(directory, deps.serverHttpUrl);
  if (!session) return { retired: false, reason: "no_login" };
  let userToken: string;
  try {
    const credential = JSON.parse(session.contents) as { accessToken?: string };
    if (!credential.accessToken) return { retired: false, reason: "no_login" };
    userToken = credential.accessToken;
  } catch {
    return { retired: false, reason: "no_login" };
  }
  const computerKey = await deps.credentials.load(deps.workspaceId, deps.computerId);
  if (!computerKey) return { retired: false, reason: "no_key" };
  const result = await deps.selfClient
    .retireSession(userToken, computerKey, signal ?? AbortSignal.timeout(30_000))
    .catch(() => undefined);
  if (!result?.ok) return { retired: false, reason: result?.error.kind ?? "failed" };
  // Re-read the file: it goes only when the bytes the call retired are still the ones there —
  // a login a person just refreshed is not this call's to delete.
  try {
    if ((await readFile(session.path, "utf8")) !== session.contents) return { retired: true };
  } catch {
    return { retired: true };
  }
  await rm(session.path, { force: true });
  return { retired: true };
}

/**
 * The scheduled retire: one call ~20s after the Workspace daemon starts, one retry ten minutes
 * later, then done. Aborted by the supervisor's own shutdown so a stop never keeps a sleep alive.
 */
export function scheduleRetireSession(deps: Parameters<typeof retireComputerSessionOnce>[0]): {
  stop(): void;
} {
  const abort = new AbortController();
  const run = async () => {
    await sleep(RETIRE_DELAY_MS, abort.signal);
    if (abort.signal.aborted) return;
    const first = await retireComputerSessionOnce(deps, abort.signal);
    if (first.retired) {
      logger.info("Computer setup login retired", { event: "computer:retire_session" });
      return;
    }
    if (abort.signal.aborted) return;
    await sleep(RETIRE_RETRY_MS, abort.signal, true);
    if (abort.signal.aborted) return;
    const second = await retireComputerSessionOnce(deps, abort.signal);
    if (second.retired)
      logger.info("Computer setup login retired", { event: "computer:retire_session" });
    else
      logger.warn("Computer setup login not retired; a later start will try again", {
        event: "computer:retire_session_failed",
        reason: second.reason,
      });
  };
  void run();
  return { stop: () => abort.abort() };
}
