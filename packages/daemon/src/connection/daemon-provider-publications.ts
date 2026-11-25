import {
  DAEMON_RUNTIME_EFFORT_READ_RESULT_METHOD,
  DAEMON_RUNTIME_MODEL_REFRESH_RESULT_METHOD,
  DAEMON_RUNTIME_RESET_CREDIT_RESULT_METHOD,
  DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
  decodeDaemonRuntimeCommandCodeEffortReadRequest,
  decodeDaemonRuntimeProviderModelRefreshRequest,
  decodeDaemonRuntimeResetCreditConsumeRequest,
  decodeDaemonRuntimeUsageScanRequest,
  encodeDaemonRuntimeCommandCodeEffortReadResponse,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  encodeDaemonRuntimeResetCreditConsumeResponse,
  encodeDaemonRuntimeUsageScanResponse,
  isResetCreditIdempotencyKey,
  type DaemonRuntimeCommandCodeEffortReadRequest,
  type DaemonRuntimeCommandCodeEffortReadResponse,
  type DaemonRuntimeProviderModelRefreshRequest,
  type DaemonRuntimeProviderModelRefreshResponse,
  type DaemonRuntimeResetCreditConsumeRequest,
  type DaemonRuntimeResetCreditConsumeResponse,
  type DaemonRuntimeUsageScanRequest,
  type DaemonRuntimeUsageScanResponse,
} from "@lrm/coforge-sdk/internal";
import { ListenerSlot } from "./listener-slot";
import type { DaemonProviderKind, PublicationKind } from "./publication-routing";

export class DaemonProviderPublications {
  readonly #usageScan = new ListenerSlot<
    (request: DaemonRuntimeUsageScanRequest) => Promise<void>
  >();
  readonly #resetCredit = new ListenerSlot<
    (request: DaemonRuntimeResetCreditConsumeRequest) => Promise<void>
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

  onResetCreditConsume(
    callback: (request: DaemonRuntimeResetCreditConsumeRequest) => Promise<void>,
  ): () => void {
    return this.#resetCredit.set(callback);
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

  routeKind(kind: DaemonProviderKind, data: Uint8Array, workspaceId: string): boolean {
    const owned = (value: { protocolMajor: number; workspaceId: string; computerId: string }) =>
      value.protocolMajor === 1 && value.workspaceId === workspaceId && !!value.computerId;
    switch (kind) {
      case "usage_scan":
        return this.#route(data, decodeDaemonRuntimeUsageScanRequest, (usage) => {
          if (!owned(usage)) return false;
          void this.#usageScan.current?.(usage);
          return true;
        });
      case "reset_credit":
        return this.#route(data, decodeDaemonRuntimeResetCreditConsumeRequest, (reset) => {
          if (!owned(reset) || !isResetCreditIdempotencyKey(reset.idempotencyKey)) return false;
          void this.#resetCredit.current?.(reset);
          return true;
        });
      case "model_refresh":
        return this.#route(data, decodeDaemonRuntimeProviderModelRefreshRequest, (refresh) => {
          if (!owned(refresh)) return false;
          void this.#modelRefresh.current?.(refresh);
          return true;
        });
      case "effort_read":
        return this.#route(data, decodeDaemonRuntimeCommandCodeEffortReadRequest, (read) => {
          if (!owned(read) || !read.modelId.trim()) return false;
          void this.#effortRead.current?.(read);
          return true;
        });
    }
  }

  route(data: Uint8Array, workspaceId: string, skip?: ReadonlySet<PublicationKind>): boolean {
    return (
      (!skip?.has("usage_scan") && this.routeKind("usage_scan", data, workspaceId)) ||
      (!skip?.has("reset_credit") && this.routeKind("reset_credit", data, workspaceId)) ||
      (!skip?.has("model_refresh") && this.routeKind("model_refresh", data, workspaceId)) ||
      (!skip?.has("effort_read") && this.routeKind("effort_read", data, workspaceId))
    );
  }

  sendUsageScanResult(response: DaemonRuntimeUsageScanResponse): Promise<unknown> {
    return this.rpc(
      DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
      encodeDaemonRuntimeUsageScanResponse(response),
    );
  }

  sendResetCreditConsumeResult(
    response: DaemonRuntimeResetCreditConsumeResponse,
  ): Promise<unknown> {
    return this.rpc(
      DAEMON_RUNTIME_RESET_CREDIT_RESULT_METHOD,
      encodeDaemonRuntimeResetCreditConsumeResponse(response),
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
