import { ComputerUpdateNoticeStore } from "../persistence/computer-update-notice-store";

/** Whether this Computer's Agents should relay a newer release to the owner. The newest version
 * arrives in ready and connection-status replies; the notice line is told once per calendar day
 * (UTC) per Computer, durable across daemon restarts so a relaunch does not repeat it. */
export class ComputerUpdateNotice {
  readonly #store: ComputerUpdateNoticeStore;
  readonly #ownVersion: string | undefined;
  readonly #now: () => number;

  constructor(
    stateDirectory: string,
    ownVersion: string | undefined,
    now: () => number = Date.now,
  ) {
    this.#store = new ComputerUpdateNoticeStore(stateDirectory);
    this.#ownVersion = ownVersion;
    this.#now = now;
  }

  /** The newest release the cloud named; ignored when absent. */
  async observeLatest(version: string | undefined): Promise<void> {
    if (!version) return;
    const state = await this.#store.read();
    if (state.latestVersion === version) return;
    await this.#store.write({ ...state, latestVersion: version });
  }

  /** The one-line notice for a CLI's output tail, or null: nothing newer, or already told today. */
  async takeNotice(): Promise<string | null> {
    if (!this.#ownVersion) return null;
    const state = await this.#store.read();
    if (!state.latestVersion || state.latestVersion === this.#ownVersion) return null;
    const today = new Date(this.#now()).toISOString().slice(0, 10);
    if (state.shownOn === today) return null;
    await this.#store.write({ ...state, shownOn: today });
    return `A newer CoForge Computer release (${state.latestVersion}) is available — this Computer runs ${this.#ownVersion}; tell the owner once and suggest \`coforge computer upgrade\`.`;
  }
}
