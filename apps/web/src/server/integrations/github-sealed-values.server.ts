import { AppError } from "#src/lib/app-error";
import { InvalidSealedValueError, SealedValues } from "#src/server/sealed-values.server";

/** AES-GCM sealing of GitHub secrets, bound to the client, the user, and the purpose. */
export class GitHubSealedValues {
  private readonly sealed: SealedValues;

  constructor(
    private readonly config: { clientId: string; encryptionKey: Uint8Array<ArrayBuffer> },
  ) {
    this.sealed = new SealedValues(config.encryptionKey);
  }

  seal(userId: string, purpose: string, value: string) {
    return this.sealed.seal(this.context(userId, purpose), value);
  }

  async open(userId: string, purpose: string, value: string) {
    try {
      return await this.sealed.open(this.context(userId, purpose), value);
    } catch (error) {
      if (error instanceof InvalidSealedValueError) throw new AppError("TEMPORARILY_UNAVAILABLE");
      throw error;
    }
  }

  private context(userId: string, purpose: string) {
    return `${this.config.clientId}:${userId}:${purpose}`;
  }
}
