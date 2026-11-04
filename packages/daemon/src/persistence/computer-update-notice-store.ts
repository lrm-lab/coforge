import { join } from "node:path";
import { writePrivateJsonRecord } from "./private-json-record";

type Record = { latestVersion?: string; shownOn?: string };

/** The Computer-update notice's durable line: the newest version the cloud named and the
 * calendar day it was last told. One file per daemon state directory, one day per computer. */
export class ComputerUpdateNoticeStore {
  readonly #path: string;
  readonly #file = Bun.file;

  constructor(stateDirectory: string) {
    if (!stateDirectory) throw new Error("Computer update notice needs a state directory");
    this.#path = join(stateDirectory, "computer-update-notice.json");
  }

  async read(): Promise<Record> {
    if (!(await this.#file(this.#path).exists())) return {};
    try {
      const value = JSON.parse(await this.#file(this.#path).text()) as Record;
      return value && typeof value === "object" ? value : {};
    } catch {
      throw new Error(`Computer update notice state is corrupt: ${this.#path}`);
    }
  }

  async write(record: Record): Promise<void> {
    await writePrivateJsonRecord(this.#path, { version: 1, ...record });
  }
}
