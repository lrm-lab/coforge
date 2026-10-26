import { PiProvider } from "@lrm/coforge-anvil/pi";
import { piRuntimeHost } from "#src/code-agent/pi/host";

export function piProvider() {
  return new PiProvider({ host: piRuntimeHost });
}
