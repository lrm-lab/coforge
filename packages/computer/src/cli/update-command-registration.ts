import type { Command } from "commander";

import { parseReleaseChannel } from "#src/release/channel-state";
import { describeUpgradePlan, planUpgrade } from "#src/cli/upgrade-plan";
import type { UpdateCommand } from "#src/cli";

export function registerUpdateCommands(
  program: Command,
  updater: UpdateCommand | undefined,
  io: { stdout: (line: string) => void; prompt?: (question: string) => string | null },
  setExitCode: (value: number) => void,
): void {
  program
    .command("install")
    .description("Install one verified Computer version for the current user.")
    .option("--version <selector>", "latest|<version>", "latest")
    .option("--channel <channel>", "latest|alpha|pinned:<version>")
    .option("--allow-downgrade", "Allow --version to be older than the installed Computer")
    .action(async (options: { version: string; channel?: string; allowDowngrade?: boolean }) => {
      const command = requireUpdater(updater);
      const channel = options.channel ?? (await command.resolveChannel?.());
      const parsedChannel = channel ? parseReleaseChannel(channel) : null;
      if (channel !== undefined && parsedChannel === null)
        throw new Error(`invalid release channel "${channel}"`);
      const version = parsedChannel?.startsWith("pinned:")
        ? await command.resolveVersion(options.version, { channel })
        : options.version;
      return command.install(version, {
        allowDowngrade: options.allowDowngrade === true,
        releaseFeedUrl: parsedChannel ? command.resolveFeedUrl?.(parsedChannel) : undefined,
        releaseChannel: parsedChannel ?? undefined,
      });
    });
  program
    .command("upgrade")
    .description(
      "Atomically move to one verified Computer version, newer or older (an older --version needs --allow-downgrade).",
    )
    .option("--version <selector>", "latest|<version>", "latest")
    .option("--channel <channel>", "latest|alpha|pinned:<version>")
    .option("--allow-downgrade", "Allow --version to be older than the installed Computer")
    .option(
      "--dry-run",
      "Show the version this would move to, and whether it would be refused, without changing anything",
    )
    .action(
      async (options: {
        version: string;
        channel?: string;
        allowDowngrade?: boolean;
        dryRun?: boolean;
      }) => {
        const allowDowngrade = options.allowDowngrade === true;
        const command = requireUpdater(updater);
        const channel = options.channel ?? (await command.resolveChannel?.());
        const parsedChannel = channel ? parseReleaseChannel(channel) : null;
        if (channel !== undefined && parsedChannel === null)
          throw new Error(`invalid release channel "${channel}"`);
        const target = await command.resolveVersion(options.version, { channel });
        if (options.dryRun) {
          const report = describeUpgradePlan(
            planUpgrade(await command.getCurrentVersion(), target, allowDowngrade),
          );
          for (const line of report.lines) io.stdout(line);
          setExitCode(report.exitCode);
          return;
        }
        if ((await command.getCurrentVersion()) === target) {
          io.stdout(`Already up to date: ${target}`);
          return;
        }
        const answer = (io.prompt ?? globalThis.prompt)(
          `Upgrade CoForge Computer to ${target}? [y/N] `,
        );
        if (!/^(y|yes)$/i.test(answer?.trim() ?? "")) {
          io.stdout("Upgrade cancelled.");
          return;
        }
        return command.upgrade(target, {
          allowDowngrade,
          releaseFeedUrl: parsedChannel ? command.resolveFeedUrl?.(parsedChannel) : undefined,
          releaseChannel: parsedChannel ?? undefined,
        });
      },
    );
}

function requireUpdater(updater: UpdateCommand | undefined): UpdateCommand {
  if (!updater) throw new Error("Updater is unavailable in this build");
  return updater;
}
