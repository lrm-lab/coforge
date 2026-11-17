import type { RuntimeEventObservationPorts } from "./runtime-event-observation-ports";

/**
 * Live getter/setter adapters that bridge `DaemonRuntime`'s private fields into port objects
 * without `this` aliasing (`typescript/no-this-alias`).
 */
export function withLiveTransport<P extends { readonly transport: unknown }>(
  read: () => P["transport"],
  rest: Omit<P, "transport">,
): P {
  return Object.defineProperty(rest, "transport", {
    enumerable: true,
    get: read,
  }) as P;
}

export function withMutableTransport<T, R extends object>(
  read: () => T,
  write: (value: T) => void,
  rest: R,
): R & { transport: T } {
  return Object.defineProperty(rest, "transport", {
    enumerable: true,
    get: read,
    set: write,
  }) as R & { transport: T };
}

export function withIdleNudge<T extends RuntimeEventObservationPorts["idleNudge"]>(
  read: () => T,
  rest: Omit<RuntimeEventObservationPorts, "idleNudge">,
): RuntimeEventObservationPorts {
  return Object.defineProperty(rest, "idleNudge", {
    enumerable: true,
    get: read,
  }) as RuntimeEventObservationPorts;
}

export function liveHoldCell<T>(read: () => T, write: (value: T) => void): { hold: T } {
  return {
    get hold() {
      return read();
    },
    set hold(value: T) {
      write(value);
    },
  };
}
