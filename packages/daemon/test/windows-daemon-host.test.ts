import { expect, test } from "bun:test";
import { WindowsUserDaemonHost, windowsDaemonTaskXml } from "#src/daemon-host/windows-task";
import { windowsUpgradeTaskXml } from "#src/platform/computer-upgrade-launcher";

test("windowsDaemonTaskXml registers a least-privilege interactive logon task", () => {
  const xml = windowsDaemonTaskXml({
    userId: "DESKTOP\\alice",
    executablePath: "C:\\Users\\alice\\Coforge\\coforge-computer.exe",
    socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
    stateDirectory: "C:\\Users\\alice\\.coforge\\daemon",
  });
  expect(xml).toContain("<LogonTrigger>");
  expect(xml).toContain("<UserId>DESKTOP\\alice</UserId>");
  expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(xml).toContain("<Command>C:\\Users\\alice\\Coforge\\coforge-computer.exe</Command>");
  expect(xml).toContain(
    "<Arguments>__daemon --socket C:\\Users\\alice\\.coforge\\daemon\\daemon.sock --state-directory C:\\Users\\alice\\.coforge\\daemon</Arguments>",
  );
  expect(xml).toContain("<RestartOnFailure>");
  expect(xml).toContain("<AllowStartOnDemand>true</AllowStartOnDemand>");
  expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
});

test("windowsDaemonTaskXml escapes XML metacharacters in paths", () => {
  const xml = windowsDaemonTaskXml({
    userId: "A&B\\user",
    executablePath: 'C:\\Path <x>&"y"\\coforge-computer.exe',
    socketPath: "C:\\sock&et.sock",
  });
  expect(xml).toContain("<UserId>A&amp;B\\user</UserId>");
  expect(xml).toContain(
    "<Command>C:\\Path &lt;x&gt;&amp;&quot;y&quot;\\coforge-computer.exe</Command>",
  );
  expect(xml).toContain("<Arguments>__daemon --socket C:\\sock&amp;et.sock</Arguments>");
});

test("windowsDaemonTaskXml wraps a connection endpoint in cmd.exe", () => {
  const xml = windowsDaemonTaskXml({
    userId: "DESKTOP\\alice",
    executablePath: "C:\\coforge-computer.exe",
    socketPath: "C:\\daemon.sock",
    daemonConnectionEndpoint: "ws://127.0.0.1:8000/connection/websocket",
  });
  expect(xml).toContain("<Command>cmd.exe</Command>");
  expect(xml).toContain("COFORGE_DAEMON_CONNECTION_ENDPOINT=");
  expect(xml).toContain("__daemon --socket C:\\daemon.sock");
});

const startConfig = {
  workspaceId: "w",
  computerId: "computer",
  workspaceRoot: "/w",
  daemonApiKey: "secret",
};

test("ensureStarted hands an unregistered task to the registrar and never creates it itself", async () => {
  const commands: string[][] = [];
  let registrations = 0;
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
    stateDirectory: "C:\\Users\\alice\\.coforge\\daemon",
    userId: "DESKTOP\\alice",
    timeoutMilliseconds: 20,
    registrar: {
      async registerAndStart() {
        registrations += 1;
      },
    },
    run: async (command) => {
      commands.push(command);
      return 1;
    },
  });
  await expect(task.ensureStarted(startConfig)).rejects.toThrow(
    "did not accept the local handshake",
  );
  expect(registrations).toBe(1);
  expect(commands).toEqual([["schtasks.exe", "/Query", "/TN", "CoForge Daemon"]]);
});

test("ensureStarted runs a registered task without registering it again", async () => {
  const commands: string[][] = [];
  let registrations = 0;
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
    userId: "DESKTOP\\alice",
    timeoutMilliseconds: 20,
    registrar: {
      async registerAndStart() {
        registrations += 1;
      },
    },
    run: async (command) => {
      commands.push(command);
      return command[1] === "/Run" ? 1 : 0;
    },
  });
  await expect(task.ensureStarted(startConfig)).rejects.toThrow(
    "Run `coforge-computer foreground` under an external supervisor",
  );
  expect(registrations).toBe(0);
  expect(commands).toEqual([
    ["schtasks.exe", "/Query", "/TN", "CoForge Daemon"],
    ["schtasks.exe", "/Run", "/TN", "CoForge Daemon"],
  ]);
});

test("Windows one-shot upgrade XML uses a locale-independent start boundary", () => {
  const xml = windowsUpgradeTaskXml({
    userId: "DESKTOP\\alice",
    action: [
      "C:\\Coforge\\coforge-computer.exe",
      "__remote-upgrade",
      "--request-id",
      "x",
      "--version",
      "1",
    ],
  });
  expect(xml).toContain("<StartBoundary>2099-01-01T00:00:00</StartBoundary>");
  expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(xml).toContain("<Command>C:\\Coforge\\coforge-computer.exe</Command>");
  expect(xml).toContain("__remote-upgrade");
});
