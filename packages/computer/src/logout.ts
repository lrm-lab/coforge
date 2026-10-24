import { normalizeServerUrl } from "./oauth-device-client";
import type { CredentialRemover } from "./login";

export type ComputerLogoutOptions = {
  store: CredentialRemover;
  writeLine: (line: string) => void;
};

export class ComputerLogout {
  constructor(private readonly options: ComputerLogoutOptions) {}

  async run(input: { serverUrl: string; json?: boolean }): Promise<{ serverUrl: string }> {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    await this.options.store.remove(serverUrl);
    if (input.json) {
      this.options.writeLine(
        JSON.stringify({ ok: true, server_url: serverUrl, bindings_kept: true }),
      );
    } else {
      this.options.writeLine(
        "Result:      Logout complete. Existing Workspace bindings were kept.",
      );
    }
    return { serverUrl };
  }
}
