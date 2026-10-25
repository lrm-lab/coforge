import { homedir } from "node:os";
import { join } from "node:path";

/** The private daemon invocation's socket and state directory, before any logging starts. */
export function daemonStartupOptions(args: string[]) {
  const argument = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const socketPath = argument("--socket");
  const stateDirectoryArg = argument("--state-directory");
  const daemonStateDirectory = stateDirectoryArg ?? join(homedir(), ".coforge", "daemon");
  return { socketPath, stateDirectoryArg, daemonStateDirectory };
}
