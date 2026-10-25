import { getLogger } from "@logtape/logtape";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { RuntimeAuthController } from "./runtime-auth-controller";

const logger = getLogger(["coforge", "daemon", "runtime-auth"]);
type Ports = Omit<
  ConstructorParameters<typeof RuntimeAuthController>[0],
  "reportLogin" | "reportLogout"
>;

/** Binds the complete private auth control/report seam before the runtime advertises support. */
export function subscribeRuntimeAuth(transport: DaemonConnectionClient, ports: Ports) {
  if (
    !transport.onRuntimeAuth ||
    !transport.reportRuntimeAuthLogin ||
    !transport.reportRuntimeAuthLogout
  )
    return undefined;
  const controller = new RuntimeAuthController({
    ...ports,
    reportLogin: (report) => transport.reportRuntimeAuthLogin!(report),
    reportLogout: (report) => transport.reportRuntimeAuthLogout!(report),
  });
  const unsubscribe = transport.onRuntimeAuth((intent) => {
    void controller.handle(intent).catch(() => {
      logger.warning("Runtime authentication control failed", {
        event: "runtime_auth:control_failed",
      });
    });
  });
  return { controller, unsubscribe };
}
