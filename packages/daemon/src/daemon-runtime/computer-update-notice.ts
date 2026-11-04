import {
  compareReleaseVersions,
  isValidReleaseVersion,
  parseReleaseVersion,
} from "@lrm/coforge-sdk/internal/release-version";
import { ComputerUpdateNoticeStore } from "../persistence/computer-update-notice-store";

/** Whether this Computer's Agents should relay a newer release to the owner. The newest version
 * arrives in ready and connection-status replies; the notice line is told once per calendar day
 * (UTC) per Workspace's daemon (each Workspace's daemon keeps its own file — several
 * Workspaces on one Computer each tell their owner once), durable across restarts. The dedup
 * file's failure never reaches the daemon: corrupt state reads as empty and the caller
 * catches any write rejection. */
export class ComputerUpdateNotice {
  readonly #store: ComputerUpdateNoticeStore;
  readonly #ownVersion: string | undefined;
  readonly #now: () => number;
  /** The one write queue: observe/take serialize so no two mutations race the file. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(
    stateDirectory: string,
    ownVersion: string | undefined,
    now: () => number = Date.now,
  ) {
    this.#store = new ComputerUpdateNoticeStore(stateDirectory);
    this.#ownVersion = ownVersion;
    this.#now = now;
  }

  /** The newest release the cloud named; a version that is not a release version is ignored. */
  observeLatest(version: string | undefined): Promise<void> {
    if (!version || !isValidReleaseVersion(version) || !parseReleaseVersion(version))
      return Promise.resolve();
    return this.#enqueue(async () => {
      const state = await this.#store.read();
      if (state.latestVersion === version) return;
      await this.#store.write({ ...state, latestVersion: version });
    });
  }

  /** The one-line notice for a CLI's output tail, or null: nothing newer, or already told today. */
  takeNotice(): Promise<string | null> {
    return this.#enqueue(async () => {
      if (!this.#ownVersion || !parseReleaseVersion(this.#ownVersion)) return null;
      const state = await this.#store.read();
      if (
        !state.latestVersion ||
        !parseReleaseVersion(state.latestVersion) ||
        compareReleaseVersions(state.latestVersion, this.#ownVersion) <= 0
      ) {
        // The feed's "latest" is behind what runs here (a stale feed, a dev build) or equal: the
        // stored value is dead weight — clearing it keeps one stale read from re-asking.
        if (state.latestVersion) await this.#store.write({ ...state, latestVersion: undefined });
        return null;
      }
      const today = new Date(this.#now()).toISOString().slice(0, 10);
      if (state.shownOn === today) return null;
      await this.#store.write({ ...state, shownOn: today });
      return (
        `A newer CoForge Computer release (${state.latestVersion}) is available — this ` +
        `Computer runs ${this.#ownVersion}; tell the owner once — they can upgrade on the ` +
        `web's Computers page or run \`coforge-computer upgrade\` on this machine.`
      );
    });
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const step = this.#chain.then(work, work);
    this.#chain = step.then(
      () => undefined,
      () => undefined,
    );
    return step;
  }
}

/** Registers the transport's latest-version feed onto the notice: every ready or heartbeat
 * reply's version is recorded. The notice is append-only output — a rejected observe (a failed
 * state write) logs and never reaches the daemon. */
export function observeLatestComputerVersion(
  transport: {
    onLatestComputerVersion?: (callback: (version: string) => void) => () => void;
  },
  notice: ComputerUpdateNotice,
  logFailure: (error: unknown) => void,
): void {
  transport.onLatestComputerVersion?.((version) => {
    void notice.observeLatest(version).catch(logFailure);
  });
}
