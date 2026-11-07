import { setupError } from "#src/errors";

export function confirmSetupIdentityChange(
  options: { machine?: string; fresh?: boolean; yes?: boolean },
  json: boolean,
  io: { stdout: (line: string) => void; prompt?: (question: string) => string | null },
): boolean {
  if (options.machine !== undefined && options.fresh)
    throw setupError("SETUP_MACHINE_INVALID", "--machine and --fresh cannot be used together.");
  if (options.machine !== undefined && !options.machine.trim())
    throw setupError("SETUP_MACHINE_INVALID", "The --machine value cannot be empty.");
  if ((options.machine !== undefined || options.fresh) && !options.yes) {
    if (json)
      throw setupError(
        "SETUP_CONFIRMATION_REQUIRED",
        "JSON setup requires --yes when --machine or --fresh changes Computer identity.",
      );
    const action = options.fresh
      ? "Create a new Computer identity"
      : `Adopt Computer '${options.machine!.trim()}'`;
    const answer = (io.prompt ?? globalThis.prompt)(`${action}? [y/N] `);
    if (!/^(y|yes)$/i.test(answer?.trim() ?? "")) {
      io.stdout("Setup cancelled.");
      return false;
    }
  }
  return true;
}
