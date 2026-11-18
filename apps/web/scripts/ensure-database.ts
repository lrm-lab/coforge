import pg from "pg";

const [adminUrl, name] = Bun.argv.slice(2);
if (!adminUrl || !name || !/^[a-z0-9_]+$/.test(name))
  throw new Error("usage: bun apps/web/scripts/ensure-database.ts <admin url> <name: a-z, 0-9, _>");
const client = new pg.Client(adminUrl);
await client.connect();
try {
  const found = await client.query("select 1 from pg_database where datname = $1", [name]);
  if (!found.rowCount) await client.query(`create database "${name}"`);
} finally {
  await client.end();
}
