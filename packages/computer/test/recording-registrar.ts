import type { CoordinatorServiceRegistrar } from "@lrm/coforge-daemon";

/** A registrar that records how often a daemon host asked it to register and start the service,
 * and fails with `failure` when given one. */
export function recordingRegistrar(failure?: Error): CoordinatorServiceRegistrar & {
  calls: number;
} {
  const registrar = {
    calls: 0,
    async registerAndStart() {
      registrar.calls += 1;
      if (failure) throw failure;
    },
  };
  return registrar;
}
