import { Centrifuge, type ErrorContext } from "centrifuge/build/protobuf";

export interface CentrifugeWorkspaceClient {
  on(event: "connected", callback: () => void): void;
  on(event: "disconnected", callback: (context?: { code: number; reason: string }) => void): void;
  /** `connect` and `transport` errors are failed connect attempts the client retries itself;
   * other types are not about connecting. */
  on(event: "error", callback: (context: ErrorContext) => void): void;
  on(
    event: "publication",
    callback: (publication: { channel: string; data: Uint8Array }) => void,
  ): void;
  connect(): void;
  disconnect(): void;
  rpc(method: string, data: Uint8Array): Promise<unknown>;
  publish?(channel: string, data: Uint8Array): Promise<unknown>;
}

export type CentrifugeWorkspaceClientFactory = (
  endpoint: string,
  token: string,
  data?: Uint8Array,
) => CentrifugeWorkspaceClient;

export const defaultCentrifugeWorkspaceClientFactory: CentrifugeWorkspaceClientFactory = (
  endpoint,
  _token,
  data,
) =>
  new Centrifuge(endpoint, {
    data,
    websocket: globalThis.WebSocket,
  }) as unknown as CentrifugeWorkspaceClient;
