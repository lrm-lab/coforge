import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";
import {
  attachPublicKeyFingerprint,
  signAttachProof,
} from "@lrm/coforge-sdk/internal/computer-attach-proof";
import {
  COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR,
  ComputerAttachErrorCode as Code,
  ComputerAttachSessionIntent as Intent,
  ComputerAttachSessionState as State,
  computerAttachWire,
} from "@lrm/coforge-sdk/internal/computer-attach-session";
import { CliError } from "#src/errors";
import type { ComputerMetadataProvider } from "./computer-setup";
import { MachineAttachError } from "./machine-attach-client";
import type { FileMachineAttachSecrets, PendingMachineAttach } from "./machine-attach-secrets";

type Binding = NonNullable<PendingMachineAttach["binding"]>;
type Stage = (stage: string, detail?: Record<string, string>) => void;

type AttachClient = {
  open(
    input: Parameters<typeof computerAttachWire.createRequest.encode>[0],
    sourceKey?: string,
  ): Promise<{
    sessionId: string;
    pollSecret: string;
    userCode?: string;
    verificationUri?: string;
    expiresInSeconds: number;
    pollIntervalSeconds: number;
  }>;
  poll(
    id: string,
    secret: string,
  ): Promise<{
    state: State;
    challenge?: { nonce: string; attachTicket?: string; expiresInSeconds: number };
  }>;
  complete(
    id: string,
    input: Parameters<typeof computerAttachWire.completeRequest.encode>[0],
  ): Promise<Binding & { resumed: boolean; apiKey: string }>;
  preflight(id: string, apiKey: string): Promise<Binding>;
};

type AttachOptions = {
  serverUrl: string;
  workspaceSlug?: string;
  metadata: Awaited<ReturnType<ComputerMetadataProvider["get"]>>;
  hostname: string;
  source?: { computerId: string; key: string };
  recover?: Binding;
  client: AttachClient;
  secrets: Pick<
    FileMachineAttachSecrets,
    "identity" | "loadPending" | "savePending" | "clearPending"
  >;
  show(line: string): void;
  onStage?: Stage;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const POLL_MS = 3000;
const COMPLETION_WINDOW_MS = 600_000;

const invalid = () =>
  new CliError(
    "ATTACH_PROTOCOL_INVALID",
    "The server returned an inconsistent Computer attach result.",
    "Run coforge-computer attach again on this Computer.",
  );

export async function runMachineAttach(options: AttachOptions) {
  const { client, secrets, metadata, show, onStage } = options;
  const origin = new URL(options.serverUrl).origin;
  const selector = options.workspaceSlug ?? "";
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const identity = await secrets.identity();
  const launch = async (recover?: Binding): Promise<PendingMachineAttach> => {
    const session = await client.open(
      {
        protocolMajor: COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR,
        intent: recover ? Intent.RECOVER : Intent.ATTACH,
        machineId: metadata.machineId,
        machineName: metadata.name,
        hostname: options.hostname,
        platform: metadata.platform,
        osVersion: metadata.osVersion,
        computerVersion: metadata.computerVersion,
        machinePublicKey: identity.publicKey,
        workspaceSlug: recover?.workspaceSlug ?? options.workspaceSlug,
        existingComputerId: recover?.computerId ?? options.source?.computerId,
      },
      recover ? undefined : options.source?.key,
    );
    if (
      !RFC_UUID_PATTERN.test(session.sessionId) ||
      !session.pollSecret ||
      session.expiresInSeconds <= 0
    )
      throw invalid();
    if (!recover) {
      if (
        !session.verificationUri ||
        !session.userCode ||
        new URL(session.verificationUri).origin !== origin
      )
        throw invalid();
    }
    const pending = {
      sessionId: session.sessionId,
      pollSecret: session.pollSecret,
      expiresAt:
        now() +
        Math.min(session.expiresInSeconds * 1000, COMPLETION_WINDOW_MS) +
        (recover ? 0 : COMPLETION_WINDOW_MS),
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      binding: recover,
    };
    await secrets.savePending(selector, pending);
    onStage?.("started", { sessionId: pending.sessionId });
    return pending;
  };

  let pending = await secrets.loadPending(selector);
  if (!pending || pending.expiresAt <= now())
    pending = await launch(options.recover ?? pending?.binding);
  if (pending.verificationUri && pending.userCode) {
    if (new URL(pending.verificationUri).origin !== origin) throw invalid();
    show(`Approve this Computer at ${pending.verificationUri}`);
    show(`Confirmation code: ${pending.userCode}`);
    show(`Machine key fingerprint: ${await attachPublicKeyFingerprint(identity.publicKey)}`);
  }

  onStage?.("polling");
  let recoveryOpened = false;
  while (now() < pending.expiresAt) {
    try {
      const poll = await client.poll(pending.sessionId, pending.pollSecret);
      if (poll.state === State.AWAITING_APPROVAL) {
        await sleep(POLL_MS);
        continue;
      }
      if ([State.BOUND, State.READY].includes(poll.state) && pending.binding && !recoveryOpened) {
        pending = await launch(pending.binding);
        recoveryOpened = true;
        continue;
      }
      const { challenge } = poll;
      if (!challenge?.nonce || ![State.APPROVED, State.COMPLETING].includes(poll.state))
        throw invalid();
      onStage?.("approved");
      const signature = await signAttachProof(identity.privateKey, {
        origin,
        sessionId: pending.sessionId,
        nonce: challenge.nonce,
        purpose: challenge.attachTicket ? "complete" : "resume",
      });
      const { computerId, workspaceId, workspaceSlug, apiKey, resumed } = await client.complete(
        pending.sessionId,
        { nonce: challenge.nonce, attachTicket: challenge.attachTicket, signature },
      );
      if (
        !RFC_UUID_PATTERN.test(computerId) ||
        !RFC_UUID_PATTERN.test(workspaceId) ||
        !workspaceSlug ||
        !apiKey
      )
        throw invalid();
      const binding = { computerId, workspaceId, workspaceSlug };
      pending = { ...pending, binding };
      await secrets.savePending(selector, pending);
      const checked = await client.preflight(pending.sessionId, apiKey);
      if (
        checked.computerId !== computerId ||
        checked.workspaceId !== workspaceId ||
        checked.workspaceSlug !== workspaceSlug
      )
        throw invalid();
      onStage?.("preflight", { computerId, workspaceSlug });
      return { ...binding, apiKey, resumed };
    } catch (error) {
      if (error instanceof MachineAttachError) {
        if (error.wireCode === Code.SLOW_DOWN || error.wireCode === Code.TICKET_CONSUMED) {
          const delay = Math.max(POLL_MS, Math.min((error.retryAfterSeconds ?? 0) * 1000, 15_000));
          await sleep(delay);
          continue;
        }
        if (
          [Code.ATTACH_SESSION_EXPIRED, Code.COMPLETION_TIMEOUT, Code.ATTACH_DENIED].includes(
            error.wireCode,
          )
        )
          await secrets.clearPending(selector);
      }
      throw error;
    }
  }
  await secrets.clearPending(selector);
  throw new MachineAttachError(Code.ATTACH_SESSION_EXPIRED);
}
