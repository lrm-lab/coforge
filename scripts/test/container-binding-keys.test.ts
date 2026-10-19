import { expect, test } from "bun:test";
import { CONTAINER_BINDING_ENV_KEYS as COMPUTER_CONTAINER_BINDING_ENV_KEYS } from "@coforge/computer/src/host/container-binding";
import { containerEnv } from "@coforge/computer/src/host/run-host";
import { CONTAINER_BINDING_ENV_KEYS } from "./isolated-test-run";

/** The isolated test run names the cloud Computer container's variables itself rather than
 * loading the Computer package; a variable added to the container without it would reach tests. */
test("the isolated test run drops every variable a cloud Computer container is started with", () => {
  const started = containerEnv(
    {
      jobId: "job",
      operation: "create",
      computerId: "computer",
      workspaceId: "workspace",
      workspaceSlug: "slug",
      name: "name",
      daemonApiKey: "key",
    },
    "https://coforge.example",
  );
  expect([...CONTAINER_BINDING_ENV_KEYS].sort()).toEqual(Object.keys(started).sort());
  expect([...CONTAINER_BINDING_ENV_KEYS].sort()).toEqual(
    [...COMPUTER_CONTAINER_BINDING_ENV_KEYS].sort(),
  );
});
