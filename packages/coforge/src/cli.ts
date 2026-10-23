#!/usr/bin/env bun
import { run } from "../index";
import { connectLocal } from "./local-client";
import { CliError, renderCliError } from "./cli-error";
import { runGitHubCli, runGitHubCredentialHelper } from "./github-credential";
import { runGitPrepareCommitMsg } from "./git-prepare-commit-msg";
import { connectAppClient } from "./app-client";
import { parseAppArgs, runAppCommand } from "./app-commands";
import { isAppRegistrationInvocation } from "./app-registration-args";
import { connectAppRegistrationClient } from "./app-registration-client";
import { runAppRegistrationCommand } from "./app-registration-commands";
import { COFORGE_CLI_VERSION } from "./version";
import { thrownMessage } from "@lrm/coforge-sdk/internal";

export async function runAgentCli(args: readonly string[]): Promise<void> {
  // `coforge --version`/`-V` reports only the CLI carrier, unlike `coforge version`, which also
  // queries the live daemon for its own and the Computer's version.
  if (args[0] === "--version" || args[0] === "-V") {
    console.log(COFORGE_CLI_VERSION);
    return;
  }

  try {
    // The app commands own their output and exit code, so neither goes through `run` (`app
    // token` also owns the program's stdio).
    if (
      args[0] === "app" &&
      ["list", "invoke", "token", "prepare", "status", "rotate-secret"].includes(args[1] ?? "")
    ) {
      const context = Bun.env.COFORGE_AGENT_CONTEXT ?? "";
      const proxyUrl = Bun.env.COFORGE_AGENT_PROXY_URL ?? "";
      const invocation = parseAppArgs(args.slice(1));
      if (isAppRegistrationInvocation(invocation)) {
        const transport = connectLocal(Bun.env.COFORGE_DAEMON_SOCKET ?? "", context, proxyUrl);
        process.exitCode = await runAppRegistrationCommand(
          invocation,
          {
            client: connectAppRegistrationClient(context, proxyUrl),
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
    const transport = connectLocal(
      Bun.env.COFORGE_DAEMON_SOCKET ?? "",
      Bun.env.COFORGE_AGENT_CONTEXT ?? "",
      Bun.env.COFORGE_AGENT_PROXY_URL ?? "",
    );
    if (args[0] === "github" && args[1] === "credential") {
      const output = await runGitHubCredentialHelper(
        args[2],
        await Bun.stdin.text(),
        transport.githubCredential,
      );
      if (output) process.stdout.write(output);
      return;
    }
    if (args[0] === "github" && args[1] === "gh") {
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
  } catch (error) {
    if (error instanceof CliError) {
      if (error.stdoutText) console.log(error.stdoutText);
      console.error(renderCliError(error));
    } else console.error(thrownMessage(error));
    process.exitCode = error instanceof CliError ? (error.exitCode ?? 1) : 1;
  }
}

if (import.meta.main) await runAgentCli(Bun.argv.slice(2));
