const responsesPath = "/v1/responses";

type FixtureTurn = {
  reply: string;
  sendReply?: { target: string; trigger: string };
};

type FixtureOptions = FixtureTurn & { apiKey: string; model: string };

type FixtureRequest = {
  method: "POST" | "other";
  path: typeof responsesPath | "other";
  model: string | null;
  bearerMatched: boolean;
  traceId: string;
  status: number;
};

function refuse(status: number, code: string) {
  return Response.json({ error: { code, message: code } }, { status });
}

async function readPayload(request: Request, model: string) {
  const data = await request.json().catch(() => null);
  return data && data.model === model && data.stream === true ? data : null;
}

function replyItems(reply: string, traceId: string, target?: string) {
  if (target) {
    const call = {
      type: "function_call",
      call_id: `call_${traceId}`,
      id: `fc_${traceId}`,
      name: "exec_command",
      status: "completed",
      arguments: JSON.stringify({
        cmd: `coforge message read --target '${target}' --unread >/dev/null && coforge message send --target '${target}' <<'COFORGE_MESSAGE'\n${reply}\nCOFORGE_MESSAGE`,
      }),
    };
    return { item: call, opening: { ...call, status: "in_progress", arguments: "" }, deltas: [] };
  }
  const content = { type: "output_text", text: reply, annotations: [] };
  const message = {
    id: `msg_${traceId}`,
    type: "message",
    role: "assistant",
    phase: "final_answer",
    status: "completed",
    content: [content],
  };
  return {
    item: message,
    opening: { ...message, status: "in_progress", content: [] },
    deltas: [
      {
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: reply,
      },
    ],
  };
}

function completedResponse(model: string, reply: string, traceId: string, target?: string) {
  const { item, opening, deltas } = replyItems(reply, traceId, target);
  const response = {
    id: `resp_${traceId}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
  };
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: opening,
    },
    ...deltas,
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  const body = events
    .map((event, index) => {
      const data = JSON.stringify({ ...event, sequence_number: index });
      return `event: ${event.type}\ndata: ${data}\n\n`;
    })
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

export function startResponsesFixture({ apiKey, model, ...initialTurn }: FixtureOptions) {
  const requests: FixtureRequest[] = [];
  let sentToolCall = false;
  let turn = initialTurn;

  function prepareReply(next: FixtureTurn) {
    if (
      next.sendReply &&
      (!/^@[a-z0-9][a-z0-9_-]*$/.test(next.sendReply.target) ||
        !/^CODEX_E2E_[a-f0-9-]+$/.test(next.reply))
    ) {
      throw new Error("The fixture requires a synthetic target and reply marker");
    }
    turn = next;
    sentToolCall = false;
  }

  prepareReply(initialTurn);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const method = request.method === "POST" ? "POST" : "other";
      const path = new URL(request.url).pathname === responsesPath ? responsesPath : "other";
      const bearerMatched = request.headers.get("authorization") === `Bearer ${apiKey}`;
      const traceId = crypto.randomUUID();
      const isResponses = method === "POST" && path === responsesPath;
      const payload = isResponses && bearerMatched ? await readPayload(request, model) : null;
      let response: Response;
      if (!isResponses) response = refuse(404, "unexpected_route");
      else if (!bearerMatched) response = refuse(401, "fixture_authentication_failed");
      else if (!payload) response = refuse(400, "unexpected_responses_payload");
      else {
        const { sendReply, reply } = turn;
        const target =
          sendReply &&
          !sentToolCall &&
          JSON.stringify(payload.input ?? []).includes(sendReply.trigger)
            ? sendReply.target
            : undefined;
        if (target) sentToolCall = true;
        response = completedResponse(model, reply, traceId, target);
      }
      requests.push({
        method,
        path,
        model: payload ? model : null,
        bearerMatched,
        traceId,
        status: response.status,
      });
      return response;
    },
  });
  return {
    baseUrl: new URL("/v1", server.url),
    requests: requests as readonly FixtureRequest[],
    prepareReply,
    stop: () => server.stop(true),
  };
}
