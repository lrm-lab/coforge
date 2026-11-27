import {
  COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR,
  COMPUTER_ATTACH_SESSIONS_PATH,
  ComputerAttachErrorCode as Code,
  computerAttachWire,
} from "@lrm/coforge-sdk/internal/computer-attach-session";
import { CliError } from "#src/errors";

const MEDIA_TYPE = "application/protobuf";
const ATTACH_CALL_TIMEOUT_MS = 15_000;
const attachRemediation = "Run coforge-computer attach again on this Computer.";
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const messages: Partial<Record<Code, { message: string; hint: string }>> = {
  [Code.ATTACH_SESSION_EXPIRED]: {
    message: "The attach session expired.",
    hint: attachRemediation,
  },
  [Code.COMPLETION_TIMEOUT]: {
    message: "The approved attach did not complete within 10 minutes.",
    hint: attachRemediation,
  },
  [Code.ATTACH_DENIED]: {
    message: "The Workspace administrator declined this attach.",
    hint: "Ask a Workspace administrator before starting a new attach.",
  },
  [Code.ATTACH_DISABLED]: {
    message: "This server has disabled Computer attach.",
    hint: "Contact the server administrator.",
  },
  [Code.REQUIRES_ADMIN]: {
    message: "The approval no longer comes from a current Workspace administrator.",
    hint: attachRemediation,
  },
  [Code.SERVER_NOT_FOUND]: {
    message: "The requested Workspace or attach endpoint could not be found.",
    hint: "Check the server and Workspace slug, then run coforge-computer attach again.",
  },
  [Code.MACHINE_KEY_MISMATCH]: {
    message: "The server could not verify this Computer's machine key.",
    hint: "Check that this is the Computer that started the attach. Start a fresh approval if its machine key was lost.",
  },
  [Code.TICKET_CONSUMED]: {
    message: "The attach challenge expired or was already used.",
    hint: attachRemediation,
  },
  [Code.RECOVERY_UNAVAILABLE]: {
    message: "This existing binding cannot be recovered with this machine key.",
    hint: "Start a fresh attach and have a Workspace administrator approve it. Older bindings need a new approval.",
  },
  [Code.INVALID_CREDENTIAL]: {
    message: "The server refused the Computer credential during attach.",
    hint: attachRemediation,
  },
  [Code.COMPUTER_CONFLICT]: {
    message: "A Computer already has this identity.",
    hint: "Use the existing Computer's valid attachment to add the Workspace, or start a new logical Computer.",
  },
  [Code.SLOW_DOWN]: {
    message: "The server asked this Computer to wait before continuing.",
    hint: attachRemediation,
  },
};

export class MachineAttachError extends CliError {
  constructor(
    readonly wireCode: Code,
    readonly retryAfterSeconds?: number,
  ) {
    const detail = messages[wireCode];
    super(
      `ATTACH_${Code[wireCode]?.replace(/^ATTACH_/, "") ?? "PROTOCOL_INVALID"}`,
      detail?.message ?? "The server refused the attach request.",
      detail?.hint ?? attachRemediation,
    );
  }
}

const invalidProtocol = () =>
  new CliError(
    "ATTACH_PROTOCOL_INVALID",
    "The server returned an invalid attach response.",
    attachRemediation,
  );

export class MachineAttachClient {
  readonly #url: string;

  constructor(
    serverUrl: string,
    private readonly request: Fetch = fetch,
  ) {
    this.#url = new URL(COMPUTER_ATTACH_SESSIONS_PATH, serverUrl).href;
  }

  async #send(path: string, method: "GET" | "POST", body?: Uint8Array, credential?: string) {
    try {
      return await this.request(this.#url + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(ATTACH_CALL_TIMEOUT_MS),
        headers: {
          accept: MEDIA_TYPE,
          ...(body ? { "content-type": MEDIA_TYPE } : {}),
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: body ? Uint8Array.from(body) : undefined,
      });
    } catch {
      throw new CliError(
        "ATTACH_NETWORK_FAILED",
        "Could not reach the server during Computer attach.",
        attachRemediation,
      );
    }
  }

  async #frame<Value>(response: Response, decode: (bytes: Uint8Array) => Value) {
    if (response.status >= 500)
      throw new CliError(
        "ATTACH_SERVER_UNAVAILABLE",
        "The server is temporarily unavailable during Computer attach.",
        attachRemediation,
      );
    if (response.headers.get("content-type") !== MEDIA_TYPE) throw invalidProtocol();
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.ok) return decode(bytes);
      const failure = computerAttachWire.error.decode(bytes);
      throw new MachineAttachError(failure.code, failure.retryAfterSeconds);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw invalidProtocol();
    }
  }

  async supported() {
    const response = await this.#send("", "GET");
    if (response.status === 404) return false;
    const { protocolMajor } = await this.#frame(response, computerAttachWire.capabilities.decode);
    if (protocolMajor === 0) return false;
    if (protocolMajor !== COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR) throw invalidProtocol();
    return true;
  }

  async open(
    input: Parameters<typeof computerAttachWire.createRequest.encode>[0],
    sourceKey?: string,
  ) {
    return this.#frame(
      await this.#send("", "POST", computerAttachWire.createRequest.encode(input), sourceKey),
      computerAttachWire.createResponse.decode,
    );
  }

  async poll(id: string, pollSecret: string) {
    return this.#frame(
      await this.#send(
        `/${id}/poll`,
        "POST",
        computerAttachWire.pollRequest.encode({ pollSecret }),
      ),
      computerAttachWire.pollResponse.decode,
    );
  }

  async complete(
    id: string,
    input: Parameters<typeof computerAttachWire.completeRequest.encode>[0],
  ) {
    return this.#frame(
      await this.#send(`/${id}/complete`, "POST", computerAttachWire.completeRequest.encode(input)),
      computerAttachWire.completeResponse.decode,
    );
  }

  async preflight(id: string, apiKey: string) {
    return this.#frame(
      await this.#send(`/${id}/preflight`, "POST", undefined, apiKey),
      computerAttachWire.preflightResponse.decode,
    );
  }
}
