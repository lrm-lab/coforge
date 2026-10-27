import {
  DAEMON_RUNTIME_EFFORT_READ_RESULT_METHOD,
  DAEMON_RUNTIME_MODEL_REFRESH_RESULT_METHOD,
  DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
  decodeDaemonRuntimeCommandCodeEffortReadRequest,
  decodeDaemonRuntimeProviderModelRefreshRequest,
  decodeDaemonRuntimeUsageScanRequest,
  encodeDaemonRuntimeCommandCodeEffortReadResponse,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  encodeDaemonRuntimeUsageScanResponse,
  type DaemonRuntimeCommandCodeEffortReadRequest,
  type DaemonRuntimeCommandCodeEffortReadResponse,
  type DaemonRuntimeProviderModelRefreshRequest,
  type DaemonRuntimeProviderModelRefreshResponse,
  type DaemonRuntimeUsageScanRequest,
  type DaemonRuntimeUsageScanResponse,
} from "@lrm/coforge-sdk/internal";
import { ListenerSlot } from "./listener-slot";

/** Usage scan, model refresh, and Command Code effort read on the daemon control channel. */
export class DaemonProviderPublications {
  readonly #usageScan = new ListenerSlot<
    (request: DaemonRuntimeUsageScanRequest) => Promise<void>
  >();
  readonly #modelRefresh = new ListenerSlot<
    (request: DaemonRuntimeProviderModelRefreshRequest) => Promise<void>
  >();
  readonly #effortRead = new ListenerSlot<
    (request: DaemonRuntimeCommandCodeEffortReadRequest) => Promise<void>
  >();

  constructor(private readonly rpc: (method: string, data: Uint8Array) => Promise<unknown>) {}

  onUsageScan(callback: (request: DaemonRuntimeUsageScanRequest) => Promise<void>): () => void {
    return this.#usageScan.set(callback);
  }

  onProviderModelRefresh(
    callback: (request: DaemonRuntimeProviderModelRefreshRequest) => Promise<void>,
  ): () => void {
    return this.#modelRefresh.set(callback);
  }

  onCommandCodeEffortRead(
    callback: (request: DaemonRuntimeCommandCodeEffortReadRequest) => Promise<void>,
  ): () => void {
    return this.#effortRead.set(callback);
  }

  /** Whether `data` was one of these publications for this Workspace. A decode miss tries the next. */
  route(data: Uint8Array, workspaceId: string): boolean {
    const owned = (value: { protocolMajor: number; workspaceId: string; computerId: string }) =>
      value.protocolMajor === 1 && value.workspaceId === workspaceId && !!value.computerId;
    return (
      this.#route(data, decodeDaemonRuntimeUsageScanRequest, (usage) => {
        if (!owned(usage)) return false;
        void this.#usageScan.current?.(usage);
        return true;
      }) ||
      this.#route(data, decodeDaemonRuntimeProviderModelRefreshRequest, (refresh) => {
        if (!owned(refresh)) return false;
        void this.#modelRefresh.current?.(refresh);
        return true;
      }) ||
      this.#route(data, decodeDaemonRuntimeCommandCodeEffortReadRequest, (read) => {
        if (!owned(read) || !read.modelId.trim()) return false;
        void this.#effortRead.current?.(read);
        return true;
      })
    );
  }

  sendUsageScanResult(response: DaemonRuntimeUsageScanResponse): Promise<unknown> {
    return this.rpc(
      DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
      encodeDaemonRuntimeUsageScanResponse(response),
    );
  }

  sendProviderModelRefreshResult(
    response: DaemonRuntimeProviderModelRefreshResponse,
  ): Promise<unknown> {
    return this.rpc(
      DAEMON_RUNTIME_MODEL_REFRESH_RESULT_METHOD,
      encodeDaemonRuntimeProviderModelRefreshResponse(response),
    );
  }

  sendCommandCodeEffortReadResult(
    response: DaemonRuntimeCommandCodeEffortReadResponse,
  ): Promise<unknown> {
    return this.rpc(
      DAEMON_RUNTIME_EFFORT_READ_RESULT_METHOD,
      encodeDaemonRuntimeCommandCodeEffortReadResponse(response),
    );
  }

  #route<Value>(
    data: Uint8Array,
    decode: (data: Uint8Array) => Value,
    accept: (value: Value) => boolean,
  ) {
    try {
      return accept(decode(data));
    } catch {
      return false;
    }
  }
}
