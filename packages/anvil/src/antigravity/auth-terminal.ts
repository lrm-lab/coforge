import { authDetail } from "#src/auth-detail";
import {
  type OwnedChildProcess,
  type OwnedProcessTree,
  type ProcessTreeSpawner,
} from "#src/process-tree";
import {
  normalizeRuntimeAuthCode,
  type RuntimeAuthLoginEvent,
  type RuntimeAuthLoginInteraction,
  type RuntimeAuthLoginResult,
  type RuntimeAuthSecretSink,
  type RuntimeAuthStatus,
} from "#src/contract";

/** `agy acp --login` waits on a person pasting a code: the same bound Claude's login gets. */
const ANTIGRAVITY_LOGIN_TIMEOUT_MS = 16 * 60 * 1_000;
/** `agy acp --help` answers at once; a probe that stalls is a broken or ancient agy. */
const ANTIGRAVITY_LOGIN_PROBE_TIMEOUT_MS = 15_000;
/** The paste prompt can print a beat before the link; give the link that long to arrive. */
const ANTIGRAVITY_LOGIN_URL_WAIT_MS = 1_000;
const ANTIGRAVITY_LOGIN_MAX_CODES = 5;

const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, "gu");
// `agy acp --login` prints "Open this link in a browser to log in with Google:" then the URL
// on its own line; the terminator keeps a chunk-split URL from counting half-written.
const LOGIN_URL = /log in with Google:\s*(https:\/\/\S+)[\r\n]/u;
const CODE_PROMPTS = /paste the authorization code[^\n]*press Enter/giu;
const LOGIN_FAILURE = /login (?:failed|cancelled)[^\n]*/iu;
const LOGIN_INSTRUCTIONS =
  "Open this URL and sign in with Google; paste back the code or the full page URL it shows.";
const CODE_PROMPT_MESSAGE =
  "Paste the authorization code, or the full URL of the page you land on.";

/** Only Google's own sign-in page is ever shown to the person as a link. */
function googleAccountsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "accounts.google.com"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Everything a short-lived auth child wrote, stdout and stderr together. */
async function readAuthChild(child: OwnedChildProcess): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const drain = async (stream: AsyncIterable<Uint8Array>) => {
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  };
  await Promise.all([
    drain(child.stdout),
    drain(child.stderr),
    child.exited.then(
      () => undefined,
      () => undefined,
    ),
  ]);
  return text;
}

/** The spawn inputs the terminal login needs — the auth host's own command, environment and
 * process ownership, nothing ambient. */
export interface AntigravityTerminalLoginHost {
  command: readonly string[];
  environment: Readonly<Record<string, string>>;
  processTreeSpawner: ProcessTreeSpawner;
}

/** Whether this agy advertises `acp --login` in its own help text — probed, not version-guessed,
 * so a backport still answers honestly. `"error"` means the probe itself could not run. */
async function terminalLoginSupport(
  host: AntigravityTerminalLoginHost,
  workingDirectory: string,
): Promise<"yes" | "no" | "error"> {
  let tree: OwnedProcessTree;
  try {
    tree = host.processTreeSpawner.spawn(
      [...host.command, "acp", "--help"],
      workingDirectory,
      host.environment,
    );
  } catch {
    return "error";
  }
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      readAuthChild(tree.child),
      new Promise<"timeout">((resolve) => {
        probeTimer = setTimeout(() => resolve("timeout"), ANTIGRAVITY_LOGIN_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (outcome === "timeout") return "error";
    return /--login\b/u.test(outcome) ? "yes" : "no";
  } catch {
    return "error";
  } finally {
    if (probeTimer) clearTimeout(probeTimer);
    await tree.terminate(true).catch(() => undefined);
  }
}

/** The headless sign-in: `agy acp --login` prints the Google OAuth link, takes the pasted
 * code or redirect URL on stdin, and shares the session's auth store — the same shape as
 * Claude's `auth login` and Raft's `runClaudeLogin`. `readStatus` re-verifies the sign-in
 * after the child exits 0; it is only agy's claim until the session probe agrees. */
export async function antigravityTerminalLogin(
  host: AntigravityTerminalLoginHost,
  options: {
    workingDirectory: string;
    timeoutMs?: number;
    onSecret?: RuntimeAuthSecretSink;
  },
  interaction: RuntimeAuthLoginInteraction,
  readStatus: () => Promise<RuntimeAuthStatus>,
): Promise<RuntimeAuthLoginResult> {
  if (interaction.signal?.aborted) return { status: "cancelled" };
  const support = await terminalLoginSupport(host, options.workingDirectory);
  if (interaction.signal?.aborted) return { status: "cancelled" };
  if (support === "no")
    return {
      status: "unsupported",
      reason: "version_unsupported",
      detail: "This agy has no `acp --login`; upgrade agy to sign in from the Web.",
    };
  if (support === "error")
    return {
      status: "failed",
      reason: "process_failed",
      detail: "agy acp --help did not answer; the installed agy may be too old or broken.",
    };
  let tree: OwnedProcessTree;
  try {
    tree = host.processTreeSpawner.spawn(
      [...host.command, "acp", "--login"],
      options.workingDirectory,
      host.environment,
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT")
      return { status: "unsupported", reason: "not_installed" };
    return {
      status: "failed",
      reason: "process_failed",
      detail: authDetail((error as Error).message),
    };
  }
  const child = tree.child;
  let exitCode: number | undefined;
  let interactionFailed: string | undefined;
  let loginFailure: string | undefined;
  let untrustedLink = false;
  let announcedUrl = false;
  let codePromptSeen = false;
  let missingAuthUrl = false;
  let authUrlWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let promptsHandled = 0;
  let codeWrites = 0;
  const settled = Promise.withResolvers<"timeout" | "cancelled" | "exited">();
  const terminate = () => void tree.terminate(true).catch(() => undefined);
  const timer = setTimeout(() => {
    terminate();
    settled.resolve("timeout");
  }, options.timeoutMs ?? ANTIGRAVITY_LOGIN_TIMEOUT_MS);
  const abort = () => {
    terminate();
    settled.resolve("cancelled");
  };
  interaction.signal?.addEventListener("abort", abort, { once: true });
  void child.exited
    .then((code) => (exitCode = code))
    .catch(() => undefined)
    .then(() => settled.resolve("exited"));

  const fail = (reason: string) => {
    interactionFailed = authDetail(reason) ?? "interaction failed";
    terminate();
  };
  const failMissingAuthUrl = () => {
    missingAuthUrl = true;
    fail("agy acp --login asked for a code before showing a sign-in link");
  };
  const emit = (event: RuntimeAuthLoginEvent) => {
    try {
      interaction.onEvent(event);
    } catch (error) {
      fail((error as Error).message);
    }
  };
  /** Asks the person for the code or redirect URL and hands it to `agy`; an empty paste is
   * asked for again, and the total writes stay bounded across re-prompts. */
  const askForCode = async (message: string) => {
    for (
      let attempt = 0;
      attempt < ANTIGRAVITY_LOGIN_MAX_CODES && !interactionFailed;
      attempt += 1
    ) {
      if (interaction.signal?.aborted) return;
      emit({ kind: "code_prompt", message });
      let code: string;
      try {
        code = normalizeRuntimeAuthCode(await interaction.prompt({ kind: "manual_code", message }));
      } catch (error) {
        if (/empty/u.test((error as Error).message)) {
          message = "No code was entered. Paste the authorization code or the full page URL.";
          continue;
        }
        return fail((error as Error).message);
      }
      if (codeWrites >= ANTIGRAVITY_LOGIN_MAX_CODES)
        return fail("agy acp --login did not accept the authorization code");
      codeWrites += 1;
      options.onSecret?.(code);
      try {
        child.stdin.write(`${code}\n`);
        await child.stdin.flush();
      } catch (error) {
        return fail((error as Error).message);
      }
      return;
    }
    if (!interactionFailed)
      fail(
        codeWrites > 0
          ? "agy acp --login did not accept the authorization code"
          : "no authorization code was entered",
      );
  };
  const requestCode = (message: string) => {
    if (announcedUrl) {
      void askForCode(message);
      return;
    }
    codePromptSeen = true;
    if (!authUrlWaitTimer) {
      authUrlWaitTimer = setTimeout(() => {
        authUrlWaitTimer = undefined;
        if (!announcedUrl && !interactionFailed) failMissingAuthUrl();
      }, ANTIGRAVITY_LOGIN_URL_WAIT_MS);
    }
  };
  const watch = async (
    stream: AsyncIterable<Uint8Array>,
    inspect: (text: string) => void,
  ): Promise<void> => {
    const decoder = new TextDecoder();
    let raw = "";
    for await (const chunk of stream) {
      raw += decoder.decode(chunk, { stream: true });
      inspect(raw.replace(ANSI, ""));
    }
  };
  const reading = Promise.all([
    watch(child.stdout, (seen) => {
      if (!announcedUrl) {
        const url = LOGIN_URL.exec(seen)?.[1];
        const trusted = url ? googleAccountsUrl(url) : undefined;
        if (trusted) {
          announcedUrl = true;
          if (authUrlWaitTimer) {
            clearTimeout(authUrlWaitTimer);
            authUrlWaitTimer = undefined;
          }
          emit({
            kind: "auth_url",
            verificationUrl: trusted,
            instructions: LOGIN_INSTRUCTIONS,
          });
          // The prompt may have printed before the link; answer it now that the URL is out.
          if (codePromptSeen) requestCode(CODE_PROMPT_MESSAGE);
        } else if (url) {
          untrustedLink = true;
          terminate();
        }
      }
      // agy re-prints the prompt for every rejected paste; each new occurrence asks again.
      const prompts = seen.match(CODE_PROMPTS)?.length ?? 0;
      if (prompts > promptsHandled) {
        promptsHandled = prompts;
        requestCode(CODE_PROMPT_MESSAGE);
      }
      loginFailure ??= LOGIN_FAILURE.exec(seen)?.[0];
    }),
    watch(child.stderr, (seen) => {
      loginFailure ??= LOGIN_FAILURE.exec(seen)?.[0];
    }),
  ]).catch(() => undefined);

  try {
    const outcome = await settled.promise;
    if (outcome === "cancelled" || interaction.signal?.aborted) return { status: "cancelled" };
    if (interactionFailed)
      return {
        status: "failed",
        reason: missingAuthUrl ? "process_failed" : "interaction_failed",
        detail: interactionFailed,
      };
    if (outcome === "timeout") return { status: "failed", reason: "timed_out" };
    await reading;
    if (untrustedLink)
      return {
        status: "failed",
        reason: "process_failed",
        detail: "agy acp --login printed a sign-in link that is not a Google address",
      };
    if (exitCode !== 0)
      return {
        status: "failed",
        reason: codeWrites > 0 ? "rejected" : "process_failed",
        detail:
          authDetail(loginFailure) ?? `agy acp --login exited with code ${exitCode ?? "unknown"}`,
      };
    const authStatus = await readStatus();
    if (authStatus.state === "logged_in") return { status: "logged_in", authStatus };
    return {
      status: "failed",
      reason: codeWrites > 0 ? "rejected" : "process_failed",
      detail: "agy acp --login finished without signing in",
    };
  } finally {
    clearTimeout(timer);
    if (authUrlWaitTimer) clearTimeout(authUrlWaitTimer);
    interaction.signal?.removeEventListener("abort", abort);
    await tree.terminate(true).catch(() => undefined);
  }
}
