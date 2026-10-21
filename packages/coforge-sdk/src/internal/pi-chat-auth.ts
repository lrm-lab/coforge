/** Internal server/host authentication. Never send the cluster secret to a browser or worker. */
export function signPiChatRequest(secret: string, time: number, body: string): string {
  return new Bun.CryptoHasher("sha256", secret).update(`${time}\n${body}`).digest("hex");
}
