export async function workerKeyId(key: JsonWebKey): Promise<string> {
  const members = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(members));
  return `coforge-e2e-${Buffer.from(digest).toString("base64url").slice(0, 16)}`;
}

if (import.meta.main) {
  const path = Bun.argv[2];
  if (!path) throw new Error("usage: bun scripts/e2e/worker-key-id.ts <worker-private.jwk>");
  console.log(await workerKeyId(await Bun.file(path).json()));
}
