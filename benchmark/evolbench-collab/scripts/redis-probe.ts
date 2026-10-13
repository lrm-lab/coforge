const line = (await Bun.file("/home/zhoujie22/river2_0/coforge/apps/web/.env").text())
  .split("\n").find(l => l.startsWith("REDIS_URL="));
const url = line!.slice("REDIS_URL=".length).trim();
const u = new URL(url);
console.log("redis host:", u.hostname, "port:", u.port || 6379, "db:", u.pathname);
try {
  const sock = Bun.connect({ hostname: u.hostname, port: Number(u.port || 6379) });
  const conn = await sock;
  await new Promise((resolve) => {
    conn.onData(() => resolve());
    conn.write(Buffer.from("PING\r\n"));
    setTimeout(resolve, 3000);
  });
  conn.end();
  console.log("redis: wrote PING (response captured above or timeout)");
} catch (e) {
  console.log("redis connect FAILED:", String(e).slice(0, 120));
}
