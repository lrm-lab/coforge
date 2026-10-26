// A fake `claude` for the structured usage reader. The mode is the first argument after the script.
const mode = process.argv[2] ?? "ok";
const argv = process.argv.slice(3);

if (argv.includes("--help")) {
  if (mode === "help-fails") process.exit(2);
  console.log(
    mode === "old"
      ? "Usage: claude [options]"
      : "Usage: claude [options]\n  --safe-mode  Start clean",
  );
  process.exit(0);
}
if (argv.includes("--json")) {
  console.log(
    JSON.stringify({ loggedIn: true, email: "frank.an@Example.com", subscriptionType: "pro" }),
  );
  process.exit(0);
}
if (argv.includes("/usage")) {
  console.log(
    JSON.stringify({ text: "Current session 25% used, resets Jan 2, 2027, 3:00pm (UTC)" }),
  );
  process.exit(0);
}
if (Bun.env.CLAUDE_FAKE_PID_FILE)
  await Bun.write(Bun.env.CLAUDE_FAKE_PID_FILE, String(process.pid));

const account = {
  email: "frank.an@Example.com",
  subscriptionType: "max",
  apiProvider: "firstParty",
};
const usage = (extra: Record<string, unknown> = {}) => ({
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    model_scoped: [
      { display_name: "Fable", utilization: 7, resets_at: "2026-10-28T13:00:00+00:00" },
    ],
    five_hour: { utilization: 26, resets_at: "2026-10-22T18:00:00.381409+00:00" },
    seven_day: { utilization: 100, resets_at: "2026-10-28T13:00:00.381426+00:00" },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 3, resets_at: "2026-10-28T13:00:00+00:00" },
  },
  extra_usage: { is_enabled: false },
  ...extra,
});

const reply = (id: string, response: unknown, error?: string) =>
  console.log(
    JSON.stringify({
      type: "control_response",
      response: error
        ? { subtype: "error", request_id: id, error }
        : { subtype: "success", request_id: id, response },
    }),
  );

if (mode === "hang") setInterval(() => {}, 1_000);
for await (const line of console) {
  const message = JSON.parse(line) as { request_id: string; request: { subtype: string } };
  const { request_id: id } = message;
  if (mode === "noise") {
    console.log("not json at all");
    console.log(JSON.stringify({ type: "system", subtype: "init" }));
    reply("someone-else", {});
  }
  if (message.request.subtype === "initialize") {
    if (mode === "hang") continue;
    if (mode === "crash") process.exit(1);
    if (mode === "logged-out") reply(id, { commands: [] });
    else if (mode === "auth-error") reply(id, undefined, "Not logged in. Run /login");
    else if (mode === "init-network-error")
      reply(id, undefined, "Failed to authenticate: network error");
    else if (mode === "api-only")
      reply(id, { account: { apiProvider: "firstParty", organization: "Acme" } });
    else if (mode === "malformed-init") reply(id, "oops");
    else reply(id, { account });
  } else if (message.request.subtype === "get_usage") {
    if (mode === "unsupported-subtype")
      reply(id, undefined, "Unsupported control request subtype: get_usage");
    else if (mode === "usage-error") reply(id, undefined, "backend exploded");
    else if (mode === "usage-auth-error") reply(id, undefined, "Not logged in");
    else if (mode === "usage-401") reply(id, undefined, "API Error: 401 OAuth token expired");
    else if (mode === "no-limits")
      reply(id, usage({ rate_limits_available: false, rate_limits: null }));
    else if (mode === "all-null")
      reply(id, usage({ rate_limits: { five_hour: null, seven_day: null } }));
    else if (mode === "bad-percent")
      reply(id, usage({ rate_limits: { five_hour: { utilization: "26" } } }));
    else if (mode === "bad-shape") reply(id, usage({ rate_limits: "nope" }));
    else if (mode === "usage-service-error")
      reply(id, undefined, "authentication service unavailable");
    else if (mode === "bad-optional")
      reply(
        id,
        usage({
          rate_limits: {
            five_hour: { utilization: 26, resets_at: "2026-10-22T18:00:00+00:00" },
            model_scoped: [{ display_name: "Fable", utilization: -4 }, "junk", { utilization: 1 }],
            seven_day_sonnet: { utilization: "x" },
          },
        }),
      );
    else if (mode === "overage")
      reply(
        id,
        usage({
          rate_limits: { five_hour: { utilization: 130, resets_at: "2026-10-22T18:00:00+00:00" } },
        }),
      );
    else if (mode === "missing-body")
      console.log(
        JSON.stringify({
          type: "control_response",
          response: { subtype: "success", request_id: id },
        }),
      );
    else reply(id, usage());
  }
}

export {};
