// ACP catalog response captured from Grok 1.0.52. Discovery may initialize and list models,
// never authenticate, create a session, or send a prompt.
const argv = process.argv.slice(2);
if (!argv.includes("agent") || !argv.includes("stdio") || !argv.includes("--no-leader"))
  process.exit(1);
const models = await Bun.file(new URL("./grok-models.json", import.meta.url)).json();
for await (const line of console) {
  const request = JSON.parse(line);
  let result: unknown;
  if (request.method === "initialize") {
    result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  } else if (request.method === "_x.ai/models/list") {
    result = { result: models };
  } else {
    throw new Error(`Catalog discovery must not call ${request.method}`);
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
