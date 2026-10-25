/** The host executes a bounded catalog probe with its own environment and process policy. */
export type CatalogCommandResult = Readonly<{ output: string; exitCode: number }>;

export type CatalogCommandRunner = (
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
) => Promise<CatalogCommandResult>;
