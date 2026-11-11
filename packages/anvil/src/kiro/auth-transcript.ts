import type { RuntimeAuthLoginEvent } from "#src/contract";
import type { KiroIdentityCenterOptions } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { kiroDeviceLinkAllowed, type KiroLinkFlow } from "./auth-link-hosts";

const logger = getLogger(["coforge", "daemon", "runtime", "kiro", "auth"]);

export class KiroAuthFailure extends Error {
  constructor(
    readonly reason: "rejected" | "timed_out" | "interaction_failed" | "process_failed",
    readonly detail?: string,
  ) {
    super(detail ?? reason);
  }
}

/** Native Kiro terminal framing. Never forwards raw terminal output or the Start URL echo. */
export class KiroEnterpriseLoginTranscript {
  #text = "";
  #startAnswered = false;
  #regionAnswered = false;
  #emitted = false;
  readonly #flow: KiroLinkFlow;
  constructor(
    /** The identity center a `pro` sign-in must land on; absent for a free sign-in, where
     * `kiro-cli` chooses the provider and no identity-center prompt appears. */
    private readonly target: KiroIdentityCenterOptions | undefined,
    private readonly write: (text: string) => void,
    private readonly emit: (event: RuntimeAuthLoginEvent) => void,
    private readonly secret?: (value: string) => void,
  ) {
    this.#flow = target === undefined ? "free" : "identity_center";
  }
  accept(chunk: string): void {
    // Kiro redraws its waiting spinner for the entire authorization window. Keep framing
    // context, not the full terminal history, so a healthy long login stays bounded.
    const pending = this.#text + chunk;
    this.#text = pending.slice(-16_384);
    const text = pending.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "");
    if (
      /device\s*(?:code|flow).{0,80}(?:disabled|not allowed)|(?:disabled|not allowed).{0,80}device\s*(?:code|flow)/iu.test(
        text,
      )
    )
      throw new KiroAuthFailure("rejected", "kiro_device_flow_disabled");
    if (/external.{0,20}(?:idp|identity provider).{0,80}(?:unsupported|not supported)/iu.test(text))
      throw new KiroAuthFailure("rejected", "kiro_external_idp_unsupported");
    if (/access_denied|authorization.{0,20}(?:denied|rejected)/iu.test(text))
      throw new KiroAuthFailure("rejected");
    if (/expired_token|(?:code|authorization).{0,30}expired/iu.test(text))
      throw new KiroAuthFailure("timed_out");
    const prompts = [
      ...text.matchAll(/(?:^|[\r\n])[^\r\n]*?(Enter Start URL|Enter Region)[^\r\n]*?[›>]/gu),
    ];
    for (const p of prompts) {
      if (p[1] === "Enter Start URL" && !this.#startAnswered) {
        this.#startAnswered = true;
        this.write("\r");
      }
      if (p[1] === "Enter Region" && !this.#regionAnswered) {
        this.#regionAnswered = true;
        this.write("\r");
      }
    }
    const lines = text.split(/[\r\n]/u);
    for (const line of lines)
      if (/(?:^\s*[?❯].*[›>]|›\s*$)/u.test(line) && !/Enter Start URL|Enter Region/u.test(line))
        throw new KiroAuthFailure("interaction_failed", "kiro_unrecognized_prompt");
    if (this.#emitted) return;
    const urls = [...text.matchAll(/https:\/\/[^\s\x1b<>]+/gu)].map((m) =>
      m[0].replace(/[),.;]+$/u, ""),
    );
    // The link is clicked in the web dialog, so only a known host is offered: a terminal's own
    // output cannot widen where a person is sent (task #615).
    const hostsOf = (raw: string) => {
      try {
        return new URL(raw).hostname;
      } catch {
        return "unparsable";
      }
    };
    const url = urls.find((raw) => raw !== this.target?.startUrl && this.#allowedLink(raw));
    const code =
      /(?:verification\s+code|one[- ]time\s+code|user\s+code|\bcode)\s*(?:is\s*)?[:：]?\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/iu.exec(
        text,
      )?.[1] ?? /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/u.exec(text)?.[1];
    if (url && code) {
      this.#emitted = true;
      // The domain a real sign-in prints is the one thing this log needs: it is how the allowlist
      // learns what kiro-cli actually uses, without ever forwarding the link itself.
      logger.info("Kiro sign-in link offered", {
        event: "runtime_auth:kiro_link_host",
        flow: this.#flow,
        host: hostsOf(url),
      });
      this.secret?.(code);
      this.secret?.(url);
      this.emit({ kind: "device_code", verificationUrl: url, userCode: code });
      return;
    }
    // A free sign-in showed a code with a link nobody here trusts: refuse it by name instead of
    // leaving the dialog waiting on a link that will never come.
    if (!url && code && this.#flow === "free" && urls.length > 0)
      throw new KiroAuthFailure(
        "rejected",
        `kiro_link_host_not_allowed:${[...new Set(urls.map(hostsOf))].join(",")}`,
      );
  }
  #allowedLink(raw: string): boolean {
    try {
      return kiroDeviceLinkAllowed(this.#flow, new URL(raw));
    } catch {
      return false;
    }
  }
}
