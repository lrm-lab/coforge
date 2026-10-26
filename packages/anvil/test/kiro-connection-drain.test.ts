import { expect, test } from "bun:test";
import { KiroConnection } from "#src/kiro/connection";
import { fixtureKiroHost } from "./fixtures/kiro-host";
import { exitingTree, modeOptions } from "./fixtures/acp-drain";

test.each([0, 10, 100])(
  "Kiro: a response written after %d notifications and just before the process exits is delivered",
  async (notifications) => {
    const connection = new KiroConnection(
      ["unused"],
      ".",
      {},
      {
        ...fixtureKiroHost,
        processTreeSpawner: {
          spawn: () => exitingTree(notifications, { configOptions: modeOptions }),
        },
      },
    );
    try {
      const response = await connection.connection.agent.request("session/set_config_option", {
        sessionId: "s",
        configId: "mode",
        value: "agent",
      });
      expect(response.configOptions).toHaveLength(1);
      // Only once everything was handled does the connection report the process as gone.
      await expect(connection.waitForConfig("s", [], "model", 1_000)).rejects.toThrow(
        "process closed before configuration",
      );
    } finally {
      await connection.dispose();
    }
  },
);
