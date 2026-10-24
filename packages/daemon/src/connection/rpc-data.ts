/** The binary payload of an RPC reply; throws for a reply that carries none. */
export function rpcData(reply: unknown): Uint8Array {
  if (!reply || typeof reply !== "object" || !("data" in reply))
    throw new Error("missing RPC response payload");
  const data = (reply as { data?: unknown }).data;
  if (!(data instanceof Uint8Array)) throw new Error("invalid RPC response payload");
  return data;
}
