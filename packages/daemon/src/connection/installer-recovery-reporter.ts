import {
  installerRecoveryChallengeSchema,
  type InstallerRecoveryObservation,
} from "@lrm/coforge-sdk/internal/installer-recovery-observation";
import { utf8Decoder } from "@lrm/coforge-sdk/internal";
import { rpcData } from "./rpc-data";

export class InstallerRecoveryReporter {
  #generation = 0;
  #sampleSequence = 0;
  #observation: InstallerRecoveryObservation = { requestChallenge: true };

  constructor(private readonly readRequired: () => Promise<boolean>) {}

  observation(): InstallerRecoveryObservation {
    return this.#observation;
  }

  async accept(reply: unknown): Promise<void> {
    let challenge: ReturnType<typeof installerRecoveryChallengeSchema.safeParse>;
    try {
      const { installerRecoveryChallenge } = JSON.parse(utf8Decoder.decode(rpcData(reply)));
      challenge = installerRecoveryChallengeSchema.safeParse(installerRecoveryChallenge);
    } catch {
      return;
    }
    if (!challenge.success || challenge.data.generation <= this.#generation) return;
    const { token, generation } = challenge.data;
    this.#generation = generation;
    this.#observation = { requestChallenge: true };
    let required = false;
    try {
      required = await this.readRequired();
    } catch {}
    if (generation === this.#generation)
      this.#observation = { challenge: token, required, sampleSequence: ++this.#sampleSequence };
  }
}
