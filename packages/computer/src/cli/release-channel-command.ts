import type { Command } from "commander";

import {
  parseReleaseChannel,
  readReleaseChannel,
  writeReleaseChannel,
} from "#src/release/channel-state";
import { resolveReleaseFeedForChannel } from "#src/release-channel";
import type { ReleaseChannel } from "#src/release/channel-state";

export interface ChannelCommand {
  show(): Promise<void>;
  set(raw: string): Promise<void>;
}

export function registerChannelCommand(program: Command, channel?: ChannelCommand): void {
  const command = program
    .command("channel")
    .description("Show or set the saved Computer release channel.");
  command
    .command("show")
    .description("Show the saved release channel.")
    .action(() => requireChannel(channel).show());
  command
    .command("set")
    .argument("<channel>", "latest, alpha, or pinned:<version>")
    .description("Set the release channel used by future upgrades.")
    .action((raw: string) => requireChannel(channel).set(raw));
}

export function createReleaseChannelCommand(
  stateDirectory: string,
  io: { stdout: (line: string) => void },
): ChannelCommand {
  return {
    show: async () => io.stdout(await readReleaseChannel(stateDirectory)),
    set: async (raw) => {
      const channel = parseReleaseChannel(raw);
      if (channel === null)
        throw new Error(`invalid release channel "${raw}"; use latest, alpha, or pinned:<version>`);
      resolveReleaseFeedForChannel(channel);
      await writeReleaseChannel(stateDirectory, channel);
      io.stdout(`Release channel set to ${channel}.`);
    },
  };
}

function requireChannel(channel: ChannelCommand | undefined): ChannelCommand {
  if (!channel) throw new Error("Release channel management is unavailable in this build");
  return channel;
}

export type { ReleaseChannel };
