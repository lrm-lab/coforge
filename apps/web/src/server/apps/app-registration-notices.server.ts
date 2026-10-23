import {
  APP_REGISTRATION_NOTICE_MESSAGE_TYPE,
  APP_REGISTRATION_NOTICE_PROTOCOL_MAJOR,
  encodeAppRegistrationNotice,
} from "@lrm/coforge-sdk/internal/app-registration-notice";

/** What a notice needs of the Agent's placement: the Computer running it, none when it has none. */
export type NoticeAgentPlacement = { workspaceId: string; computerId: string | null } | undefined;

/**
 * Hands the client secret of a newly registered app to its owner Agent, privately and once: a
 * single notice on the daemon control channel of the Computer running the Agent, and only when that
 * daemon's ready advertised `app-registration-notice:v1`. Best effort, with no retry and no spool;
 * the secret is not stored, logged or written anywhere here. An Agent that misses it runs
 * `coforge app rotate-secret`.
 */
export class AppRegistrationNotices {
  constructor(
    private readonly placement: (agentId: string) => Promise<NoticeAgentPlacement>,
    private readonly capability: {
      supports(workspaceId: string, computerId: string): Promise<boolean>;
    },
    private readonly publish: (
      workspaceId: string,
      computerId: string,
      payload: Uint8Array,
    ) => Promise<unknown>,
  ) {}

  /** Whether the notice was sent. */
  async send(notice: {
    agentId: string;
    appKey: string;
    appName: string;
    clientSecret: string;
  }): Promise<boolean> {
    try {
      const placement = await this.placement(notice.agentId);
      const computerId = placement?.computerId;
      if (!placement || !computerId) return false;
      if (!(await this.capability.supports(placement.workspaceId, computerId))) return false;
      await this.publish(
        placement.workspaceId,
        computerId,
        encodeAppRegistrationNotice({
          protocolMajor: APP_REGISTRATION_NOTICE_PROTOCOL_MAJOR,
          requestId: crypto.randomUUID(),
          workspaceId: placement.workspaceId,
          computerId,
          messageType: APP_REGISTRATION_NOTICE_MESSAGE_TYPE,
          ...notice,
        }),
      );
      return true;
    } catch (error) {
      // Only the error's class: a message could quote the notice.
      console.warn(
        JSON.stringify({
          event: "app_registration_notice:publish_failed",
          agent_id: notice.agentId,
          app_key: notice.appKey,
          error_code: error instanceof Error ? error.name : "unknown",
        }),
      );
      return false;
    }
  }
}
