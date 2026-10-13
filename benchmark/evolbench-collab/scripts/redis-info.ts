const line = (await Bun.file("/home/zhoujie22/river2_0/coforge/apps/web/.env").text())
  .split("\n").find(l => l.startsWith("REDIS_URL="));
const u = new URL(line!.slice("REDIS_URL=".length).trim());
const conn = await Bun.connect({
  hostname: u.hostname, port: Number(u.port || 6379),
  socket: { data(socket, chunk) { (socket as any).__buf = ((socket as any).__buf ?? "") + chunk.toString(); } },
});
const send = async (cmd: string) => {
  (conn as any).__buf = "";
  conn.write(cmd + "\r\n");
  await Bun.sleep(600);
  return (conn as any).__buf;
};
const r1 = await send(`AUTH ${decodeURIComponent(u.password ?? "")}`);
console.log("auth:", r1.trim().slice(0, 20));
const info = await send("INFO clients");
console.log(info.split("\n").filter(l => /connected_clients|maxclients|blocked_clients|cluster_connections/.test(l)).join("").trim());
const cfg = await send("CONFIG GET maxclients");
console.log("cfg maxclients:", cfg.trim().split("\n").slice(0, 4).join(" | "));
const list = await send("CLIENT LIST");
const rows = list.trim().split("\n").slice(1);
console.log("client list rows:", rows.length);
const byAddr = new Map<string, number>();
for (const r of rows) {
  const addr = r.split(" ").find(s => s.startsWith("addr="))?.slice(5) ?? "?";
  const host = addr.split(":")[0];
  byAddr.set(host, (byAddr.get(host) ?? 0) + 1);
}
for (const [h, n] of [...byAddr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${h}: ${n} conns`);
const names = new Map<string, number>();
for (const r of rows) {
  const nm = r.split(" ").find(s => s.startsWith("name="))?.slice(5) || "(unnamed)";
  names.set(nm, (names.get(nm) ?? 0) + 1);
}
for (const [nm, n] of [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  name=${nm}: ${n}`);
conn.end();
