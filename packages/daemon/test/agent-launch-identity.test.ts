import { expect, test } from "bun:test";
import { parseAgentLaunchIdentity } from "#src/connection/agent-launch-identity";

test("the installed apps survive the launch-config JSON round trip", () => {
  const sent = {
    name: "scout",
    apps: [
      {
        key: "acme-notes",
        name: "Acme Notes",
        description: "Notes for the team.",
        whenToUse: "Read or write the team's notes.",
      },
      { key: "zeta-board", name: "Zeta Board" },
    ],
  };
  expect(parseAgentLaunchIdentity(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
});

test("a launch identity from an older server, with no apps, parses without them", () => {
  expect(parseAgentLaunchIdentity({ name: "scout" })).toEqual({ name: "scout" });
  expect(parseAgentLaunchIdentity({ name: "scout", apps: [] })).toEqual({ name: "scout" });
});

test("a malformed app is dropped without dropping the others or the identity", () => {
  const identity = parseAgentLaunchIdentity({
    name: "scout",
    apps: [
      null,
      "acme-notes",
      { name: "No key" },
      { key: "no-name" },
      { key: "Bad Key`", name: "Breaks code spans" },
      { key: "system.cleaner", name: "Built-in keys are not registry keys" },
      { key: "acme-notes", name: "  Acme `Notes`  ", description: 7, whenToUse: "  " },
    ],
  });
  expect(identity).toEqual({
    name: "scout",
    apps: [{ key: "acme-notes", name: "Acme 'Notes'" }],
  });
  expect(parseAgentLaunchIdentity({ name: "scout", apps: { key: "acme-notes" } })).toEqual({
    name: "scout",
  });
});

test("at most the cap of apps is kept", () => {
  const apps = Array.from({ length: 40 }, (_, index) => ({ key: `app-${index}`, name: "App" }));
  expect(parseAgentLaunchIdentity({ apps })?.apps).toHaveLength(20);
});
