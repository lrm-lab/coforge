#!/usr/bin/env bun
import { run } from "../index";
import { connectLocal } from "./local-client";
import { updateNoticeLine } from "./update-notice";
import { CliError, renderCliError } from "./cli-error";
import { runGitHubCli, runGitHubCredentialHelper } from "./github-credential";
import { runGitPrepareCommitMsg } from "./git-prepare-commit-msg";
import { connectAppClient } from "./app-client";
import { parseAppArgs, runAppCommand } from "./app-commands";
import { isAppManagementInvocation } from "./app-management-args";
import { connectAppManagementClient } from "./app-management-client";
import { runAppManagementCommand } from "./app-management-commands";
import { isAppRegistrationInvocation } from "./app-registration-args";
import { connectAppRegistrationClient } from "./app-registration-client";
import { runAppRegistrationCommand } from "./app-registration-commands";
import { COFORGE_CLI_VERSION } from "./version";
import { cliUsage } from "./usage";
import { commandHelp } from "./command-help";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import { isAgentSubcommand, runAgentSubcommand } from "./external/agent-cli";
import { connectExternal } from "./external/direct-transport";
import { selectProfile } from "./external/profile-select";
import { profileStore } from "./external/profile-store";
import { daemonOnlyError } from "./external/refusal";
import { resolveAgentTransport } from "./external/resolve-transport";

export async function runAgentCli(argv: readonly string[]): Promise<void> {
  let args = argv;
  // `coforge --version`/`-V` reports only the CLI carrier, unlike `coforge version`, which also
  // queries the live daemon for its own and the Computer's version.
  if (args[0] === "--version" || args[0] === "-V") {
    console.log(COFORGE_CLI_VERSION);
    return;
  }

  // No command at all is a mistake, not a request: the usage goes to stderr and the process
  // fails, so a script that forgot its arguments never reads it as a successful run.
  if (args.length === 0) {
    console.error(cliUsage());
    process.exitCode = 1;
    return;
  }

  let transport: ReturnType<typeof connectLocal> | undefined;
  let external: ReturnType<typeof connectExternal> | undefined;
  try {
    const selection = selectProfile(args, Bun.env);
    args = selection.args;
    if (isAgentSubcommand(args) && !args.includes("--help")) {
      await runAgentSubcommand(args, selection.slug, Bun.env);
      return;
    }
    const store = profileStore(Bun.env);
    const target = await resolveAgentTransport(Bun.env, selection.slug, store);
    if (target.mode === "external") {
      external = connectExternal(
        {
          slug: target.profileSlug,
          path: store.pathOf(target.profileSlug),
          profile: target.profile,
        },
        store,
      );
      transport = external.transport;
    } else transport = connectLocal(target.socketPath, target.context, target.proxyUrl);
    // The app commands own their output and exit code, so neither goes through `run` (`app
    // token` also owns the program's stdio). `app config` alone stays with `run`. `--help`
    // keeps `run`'s help lookup — anything after `--` is the token program's, not ours.
    if (args[0] === "app" && args[1] !== "config") {
      const separator = args.indexOf("--");
      const own = separator === -1 ? args : args.slice(0, separator);
      const help = own.includes("--help")
        ? commandHelp(own.filter((arg) => arg !== "--help"))
        : undefined;
      if (help !== undefined) {
        process.stdout.write(`${help}\n`);
        return;
      }
      const { context, proxyUrl } = target;
      const invocation = parseAppArgs(args.slice(1));
      if (isAppRegistrationInvocation(invocation)) {
        const transport = connectLocal(target.socketPath, context, proxyUrl);
        process.exitCode = await runAppRegistrationCommand(
          invocation,
          {
            client: connectAppRegistrationClient(context, proxyUrl),
            prepare: (target, action) => transport.actionPrepare!(target, action),
          },
          { stdout: (text) => process.stdout.write(text) },
        );
      } else if (isAppManagementInvocation(invocation)) {
        const transport = connectLocal(target.socketPath, context, proxyUrl);
        process.exitCode = await runAppManagementCommand(
          invocation,
          {
            client: connectAppManagementClient(context, proxyUrl),
            prepare: (target, action) => transport.actionPrepare!(target, action),
          },
          { stdout: (text) => process.stdout.write(text) },
        );
      } else
        process.exitCode = await runAppCommand(invocation, connectAppClient(context, proxyUrl), {
          stdout: (chunk) => process.stdout.write(chunk),
          stderr: (chunk) => process.stderr.write(chunk),
          env: Bun.env,
        });
      return;
    }
    if (args[0] === "github" && args[1] === "credential") {
      if (external)
        throw daemonOnlyError("The GitHub credential helper needs the Computer's daemon.");
      const output = await runGitHubCredentialHelper(
        args[2],
        await Bun.stdin.text(),
        transport.githubCredential,
      );
      if (output) process.stdout.write(output);
      return;
    }
    if (args[0] === "github" && args[1] === "gh") {
      if (external)
        throw daemonOnlyError("The GitHub credential helper needs the Computer's daemon.");
      process.exitCode = await runGitHubCli(args.slice(2), transport.githubCredential);
      return;
    }
    if (args[0] === "git" && args[1] === "prepare-commit-msg") {
      // This hook must never fail the Agent's commit: any failure is one plain-language stderr
      // line, and the process always exits 0 regardless of what happened above.
      try {
        await runGitPrepareCommitMsg(args.slice(2), transport.githubCommitTrailers!);
      } catch (error) {
        console.error(`coforge: CoForge co-author trailer skipped: ${thrownMessage(error)}`);
      }
      process.exitCode = 0;
      return;
    }
    const result = await run(args, transport);
    if (typeof result === "string") console.log(result);
    else if (result !== undefined) console.log(JSON.stringify(result));
    await external?.commit();
    // The once-a-day Computer-update line rides the output tail: the daemon dedups, this side
    // only decides whether a line may follow — never for `--json`, never from an error below.
    const notice = transport && !external ? await updateNoticeLine(transport, args) : undefined;
    if (notice) console.error(notice);
  } catch (error) {
    if (error instanceof CliError) {
      if (error.stdoutText) console.log(error.stdoutText);
      console.error(renderCliError(error));
    } else console.error(thrownMessage(error));
    process.exitCode = error instanceof CliError ? (error.exitCode ?? 1) : 1;
    const notice = transport && !external ? await updateNoticeLine(transport, args) : undefined;
    if (notice) console.error(notice);
  }
}

if (import.meta.main) await runAgentCli(Bun.argv.slice(2));
