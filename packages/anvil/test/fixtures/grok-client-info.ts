export {};

if (process.argv.includes("--version")) {
  console.log("grok 1.0.62 (fixture)");
  process.exit(0);
}
let clientInfo: unknown;
for await (const line of console) {
  const request = JSON.parse(line);
  const reply = (result: unknown) =>
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  switch (request.method) {
    case "initialize":
      clientInfo = request.params.clientInfo;
      reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "cached_token", name: "Cached" }],
      });
      break;
    case "authenticate":
      reply({});
      break;
    case "session/new":
      reply({ sessionId: JSON.stringify(clientInfo) });
      break;
    case "_x.ai/models/list":
      reply({
        result: {
          currentModelId: JSON.stringify(clientInfo),
          availableModels: [{ modelId: JSON.stringify(clientInfo) }],
        },
      });
      break;
    case "_x.ai/billing":
      reply({ subscription_tier: JSON.stringify(clientInfo), config: { creditUsagePercent: 12 } });
      break;
    case "_x.ai/auth/info":
      reply({ email: "ada@example.com" });
      break;
  }
}
