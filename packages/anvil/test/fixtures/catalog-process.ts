for await (const line of console) {
  const request = JSON.parse(line);
  console.log(
    JSON.stringify(
      request.method === "fail"
        ? { id: request.id, error: { code: 418, message: "untrusted provider detail" } }
        : {
            id: request.id,
            result: {
              cwd: process.cwd(),
              value: Bun.env.CATALOG_FIXTURE_VALUE,
              codexHome: Bun.env.CODEX_HOME,
              color: Bun.env.FORCE_COLOR,
              noColor: Bun.env.NO_COLOR,
              daemonHome: Bun.env.COFORGE_DAEMON_HOME ?? null,
            },
          },
    ),
  );
}

export {};
