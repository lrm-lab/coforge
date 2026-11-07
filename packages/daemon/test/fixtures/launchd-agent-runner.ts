import { runLaunchdAgent } from "#src/platform/launchd-agent-runner";
await runLaunchdAgent(Bun.argv.at(-1)!);
