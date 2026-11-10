import {
  isResetCreditIdempotencyKey,
  type DaemonRuntimeResetCreditConsumeRequest,
  type DaemonRuntimeResetCreditConsumeResponse,
  type ResetCreditOutcome,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

import type { RuntimeAuthUnavailable } from "./runtime-auth.server";

type Scope = { workspaceId: string; computerId: string };

/** What starting an attempt tells the page. `refused` means nothing was sent and the attempt may
 * be made again as it was; `started` names the request whose answer `read` returns. */
export type ResetCreditStart =
  | { status: "started"; requestId: string }
  | { status: "refused"; reason: "forbidden" | RuntimeAuthUnavailable };

/** What reading an attempt tells the page: no answer yet, the Computer's answer, or a refusal. */
export type ResetCreditRead =
  | { status: "pending" }
  | { status: "settled"; outcome: ResetCreditOutcome }
  | { status: "refused"; reason: "forbidden" };

/**
 * Spending a rate-limit reset credit of the account a runtime is signed in to, on a Computer, from
 * the web. It spends the owner's credit, so only who may sign the runtime in or out may ask or read
 * (the Computer's owner, or a Workspace owner or admin: stricter than a usage scan). Starting
 * publishes the request once and returns at once; production closes a request idle for about ten
 * seconds, and the Computer can take longer, so the page reads the answer by polling. The attempt's
 * idempotency key goes to the provider as given, so a retry after an unknown outcome cannot spend a
 * second credit. The key is checked here and never logged.
 */
export class RuntimeResetCredit {
  constructor(
    private readonly dependencies: {
      authorization: {
        canManage(scope: Scope & { userId: string; provider: RuntimeProvider }): Promise<boolean>;
      };
      computerStatus: { get(scope: Scope): Promise<boolean> };
      /** Whether the Computer's daemon takes the request; an older one is never sent it. */
      capability: { supports(workspaceId: string, computerId: string): Promise<boolean> };
      results: {
        begin(pending: {
          request: DaemonRuntimeResetCreditConsumeRequest;
          userId: string;
          revision: string;
        }): Promise<void>;
        read(requestId: string): Promise<DaemonRuntimeResetCreditConsumeResponse | undefined>;
      };
      publish(request: DaemonRuntimeResetCreditConsumeRequest): Promise<void>;
    },
  ) {}

  async start(
    principal: { userId: string; workspaceId: string },
    input: { computerId: string; provider: RuntimeProvider; idempotencyKey: string },
  ): Promise<ResetCreditStart> {
    if (!isResetCreditIdempotencyKey(input.idempotencyKey))
      throw new Error("invalid reset credit idempotency key");
    const { authorization, computerStatus, capability, results, publish } = this.dependencies;
    const scope = { workspaceId: principal.workspaceId, computerId: input.computerId };
    if (
      !(await authorization.canManage({
        ...scope,
        userId: principal.userId,
        provider: input.provider,
      }))
    )
      return { status: "refused", reason: "forbidden" };
    const [online, supported] = await Promise.all([
      computerStatus.get(scope),
      capability.supports(scope.workspaceId, scope.computerId),
    ]);
    if (!online) return { status: "refused", reason: "offline" };
    if (!supported) return { status: "refused", reason: "needs_upgrade" };
    const request: DaemonRuntimeResetCreditConsumeRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      ...scope,
      provider: input.provider,
      idempotencyKey: input.idempotencyKey,
    };
    // A store that cannot record the request is a failure: nothing was sent, and the page shows
    // its generic failure with the attempt's key kept.
    await results.begin({ request, userId: principal.userId, revision: "" });
    try {
      await publish(request);
    } catch {
      // The request may have been delivered before the failure. Whether the credit was spent is
      // not known, so the request stays pending: a late answer is still taken, and a page that
      // gets none ends at `unknown` with its key kept.
    }
    return { status: "started", requestId: request.requestId };
  }

  /**
   * The Computer's answer to one attempt, for a person who may manage the runtime. A page polls
   * this about once a second, and "pending" says nothing, so only an answer that names the
   * caller's Workspace, Computer and runtime is checked against `canManage`, and only then
   * returned: a request id alone reaches nothing else, and nobody else receives an outcome. The
   * answer is left to expire, so a page that lost the reply can ask again.
   */
  async read(
    principal: { userId: string; workspaceId: string },
    input: { computerId: string; provider: RuntimeProvider; requestId: string },
  ): Promise<ResetCreditRead> {
    const scope = { workspaceId: principal.workspaceId, computerId: input.computerId };
    const answer = await this.dependencies.results.read(input.requestId);
    if (
      !answer ||
      answer.workspaceId !== scope.workspaceId ||
      answer.computerId !== scope.computerId ||
      answer.provider !== input.provider
    )
      return { status: "pending" };
    if (
      !(await this.dependencies.authorization.canManage({
        ...scope,
        userId: principal.userId,
        provider: input.provider,
      }))
    )
      return { status: "refused", reason: "forbidden" };
    return { status: "settled", outcome: answer.outcome };
  }
}
