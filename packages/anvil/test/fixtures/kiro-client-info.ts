export {};

const expected = JSON.parse(
  process.argv
    .find((arg) => arg.startsWith("--expect-client-info="))!
    .slice("--expect-client-info=".length),
);
for await (const line of console) {
  const request = JSON.parse(line);
  const response = (result: unknown) =>
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  if (request.method === "initialize") {
    if (JSON.stringify(request.params.clientInfo) !== JSON.stringify(expected)) {
      console.log(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "Unexpected clientInfo" },
        }),
      );
    } else {
      response({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, _meta: { kiro: { replayMarking: true } } },
      });
    }
  } else if (request.method === "session/new") {
    response({
      sessionId: "client-info-fixture",
      configOptions: [
        {
          id: "model",
          category: "model",
          name: "Model",
          type: "select",
          currentValue: "auto",
          options: [{ value: "auto", name: "Auto" }],
        },
      ],
    });
  }
}
