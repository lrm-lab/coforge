import * as appsWire from "./apps";
import * as appMarketplaceWire from "./app-marketplace";
import * as appManagementWire from "./app-management";
import * as appRegistrationWire from "./app-registration";
import * as inboxActionsWire from "./inbox-actions";
import type { AgentActionPrepareRequest, AgentActionPrepareResponse } from "./action-cards";
import type { AgentArtifactRequest } from "./artifacts";
import type { AgentThreadAttentionResponse } from "./messages";
import type { AgentApiResult, AgentApiTransport } from "./client";
import { agentApiRoutes } from "./routes";

export type AgentCommandGuidanceRequest = {
  operation: "check" | "satisfy";
  command: string;
};

export type AgentCommandGuidanceResponse = {
  ok: true;
  guidance: string | null;
  mode?: "once_per_context" | "inline";
};

export const AGENT_COMMAND_GUIDANCE: Readonly<Record<string, string>> = {
  task: "[Guidance] Pass '#channel:#7' (or 'dm:@peer:#7') directly to task commands; use `task assign '<ref>' --assignee @who --reason \"...\"` for handoffs.",
  action:
    "[Guidance] `action prepare` supports `choice` and multi-question `questions` cards; retract obsolete unanswered cards with `coforge action withdraw --message <id>`.",
  inbox:
    "[Guidance] Use `coforge inbox read --target <item>` to page unread items or `coforge inbox dismiss --before <iso>` to clear stale backlog.",
  message:
    "[Guidance] Clear an obsolete held send draft without sending via `coforge message send --target <target> --discard-draft`.",
};

type AppManagementOp = appManagementWire.AgentAppManagementRequest["operation"];
type AppManagementBody<Op extends AppManagementOp> = Omit<
  Extract<appManagementWire.AgentAppManagementRequest, { operation: Op }>,
  "operation"
>;

const APP_MANAGEMENT_DECODERS = {
  rotate_secret: appRegistrationWire.decodeAppSecretRotationResponse,
  update: appManagementWire.decodeAppManagedResponse,
  logo_set: appManagementWire.decodeAppManagedResponse,
  logo_clear: appManagementWire.decodeAppManagedResponse,
  transfer_owner: appManagementWire.decodeAppOwnerTransferResponse,
  delete: appManagementWire.decodeAppDeletedResponse,
  share_link_create: appManagementWire.decodeAppShareLinkCreatedResponse,
  share_link_status: appManagementWire.decodeAppShareLinkStatusResponse,
  share_link_revoke: appManagementWire.decodeAppShareLinkRevokedResponse,
  request_publish: appManagementWire.decodeAppPublishRequestResponse,
  request_unpublish: appManagementWire.decodeAppPublishRequestResponse,
} as const satisfies Record<AppManagementOp, (value: unknown) => unknown>;

export type RawAgentApiExtendedClient = {
  actions: {
    prepare(
      request: AgentActionPrepareRequest,
    ): Promise<AgentApiResult<AgentActionPrepareResponse>>;
    withdraw(
      request: inboxActionsWire.AgentActionWithdrawRequest,
    ): Promise<AgentApiResult<inboxActionsWire.AgentActionWithdrawResponse>>;
  };
  inbox: {
    read(
      request: inboxActionsWire.AgentInboxReadRequest,
    ): Promise<AgentApiResult<inboxActionsWire.AgentInboxReadResponse>>;
    dismiss(
      request: inboxActionsWire.AgentInboxDismissRequest,
    ): Promise<AgentApiResult<inboxActionsWire.AgentInboxDismissResponse>>;
  };
  threads: {
    follow(threadId: string): Promise<AgentApiResult<AgentThreadAttentionResponse>>;
    unfollow(threadId: string): Promise<AgentApiResult<AgentThreadAttentionResponse>>;
  };
  artifacts: {
    execute(request: AgentArtifactRequest): Promise<AgentApiResult<unknown>>;
  };
  apps: {
    list(): Promise<AgentApiResult<appsWire.AgentAppListResponse>>;
    marketplace(input?: {
      query?: string;
      limit?: number;
    }): Promise<AgentApiResult<appMarketplaceWire.AgentAppMarketplaceResponse>>;
    token(
      appKey: string,
      input?: { target?: string; scopes?: string[] },
    ): Promise<AgentApiResult<appsWire.AgentAppTokenResponse>>;
    registrations: {
      status(
        selector: { card: string } | { client: string },
      ): Promise<AgentApiResult<appRegistrationWire.AppRegistrationStatusResponse>>;
      owned(): Promise<AgentApiResult<appRegistrationWire.AppOwnedListResponse>>;
      rotateSecret(
        clientKey: string,
      ): Promise<AgentApiResult<appRegistrationWire.AppSecretRotationResponse>>;
    };
    management: {
      execute<Op extends AppManagementOp>(
        operation: Op,
        body: AppManagementBody<Op>,
      ): Promise<AgentApiResult<ReturnType<(typeof APP_MANAGEMENT_DECODERS)[Op]>>>;
    };
  };
};

export type AgentApiExtendedClient = {
  actions: {
    prepare(request: AgentActionPrepareRequest): Promise<AgentActionPrepareResponse>;
    withdraw(
      request: inboxActionsWire.AgentActionWithdrawRequest,
    ): Promise<inboxActionsWire.AgentActionWithdrawResponse>;
  };
  inbox: {
    read(
      request: inboxActionsWire.AgentInboxReadRequest,
    ): Promise<inboxActionsWire.AgentInboxReadResponse>;
    dismiss(
      request: inboxActionsWire.AgentInboxDismissRequest,
    ): Promise<inboxActionsWire.AgentInboxDismissResponse>;
  };
  threads: {
    follow(threadId: string): Promise<AgentThreadAttentionResponse>;
    unfollow(threadId: string): Promise<AgentThreadAttentionResponse>;
  };
  artifacts: {
    execute(request: AgentArtifactRequest): Promise<unknown>;
  };
  apps: {
    list(): Promise<appsWire.AgentAppListResponse>;
    marketplace(input?: {
      query?: string;
      limit?: number;
    }): Promise<appMarketplaceWire.AgentAppMarketplaceResponse>;
    token(
      appKey: string,
      input?: { target?: string; scopes?: string[] },
    ): Promise<appsWire.AgentAppTokenResponse>;
    registrations: {
      status(
        selector: { card: string } | { client: string },
      ): Promise<appRegistrationWire.AppRegistrationStatusResponse>;
      owned(): Promise<appRegistrationWire.AppOwnedListResponse>;
      rotateSecret(clientKey: string): Promise<appRegistrationWire.AppSecretRotationResponse>;
    };
    management: {
      execute<Op extends AppManagementOp>(
        operation: Op,
        body: AppManagementBody<Op>,
      ): Promise<ReturnType<(typeof APP_MANAGEMENT_DECODERS)[Op]>>;
    };
  };
};

function decodeResult<T>(
  result: AgentApiResult<unknown>,
  decode: (value: unknown) => T,
): AgentApiResult<T> {
  if (!result.ok) return result;
  return { ok: true, status: result.status, data: decode(result.data) };
}

export function createRawExtendedResources(
  transport: AgentApiTransport,
): RawAgentApiExtendedClient {
  const { list, marketplace, token } = agentApiRoutes.local.apps;
  const registrationsRoute = agentApiRoutes.local.appRegistrations;
  return {
    actions: {
      prepare: (request) =>
        transport.request(agentApiRoutes.cloud.actionPrepare, request) as Promise<
          AgentApiResult<AgentActionPrepareResponse>
        >,
      withdraw: async (request) =>
        decodeResult(
          await transport.request(agentApiRoutes.cloud.actionWithdraw, request),
          inboxActionsWire.decodeAgentActionWithdrawResponse,
        ),
    },
    inbox: {
      read: async (request) =>
        decodeResult(
          await transport.request(agentApiRoutes.cloud.inboxRead, {
            target: request.target,
            ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          }),
          inboxActionsWire.decodeAgentInboxReadResponse,
        ),
      dismiss: async (request) =>
        decodeResult(
          await transport.request(agentApiRoutes.cloud.inboxDismiss, request),
          inboxActionsWire.decodeAgentInboxDismissResponse,
        ),
    },
    threads: {
      follow: (threadId) =>
        transport.request(agentApiRoutes.cloud.threads.follow.path(threadId)) as Promise<
          AgentApiResult<AgentThreadAttentionResponse>
        >,
      unfollow: (threadId) =>
        transport.request(agentApiRoutes.cloud.threads.unfollow.path(threadId)) as Promise<
          AgentApiResult<AgentThreadAttentionResponse>
        >,
    },
    artifacts: {
      execute: (request) => transport.request(agentApiRoutes.local.artifacts, request),
    },
    apps: {
      list: async () =>
        decodeResult(await transport.request(list), appsWire.decodeAgentAppListResponse),
      marketplace: async (input) =>
        decodeResult(
          await transport.request(marketplace, {
            ...(input?.query === undefined ? {} : { query: input.query }),
            ...(input?.limit === undefined ? {} : { limit: String(input.limit) }),
          }),
          appMarketplaceWire.decodeAgentAppMarketplaceResponse,
        ),
      token: async (appKey, input) =>
        decodeResult(
          await transport.request(
            { method: token.method, path: token.path(appKey) },
            {
              ...(input?.target ? { target: input.target } : {}),
              ...(input?.scopes ? { scopes: input.scopes } : {}),
            },
          ),
          appsWire.decodeAgentAppTokenResponse,
        ),
      registrations: {
        status: async (selector) =>
          decodeResult(
            await transport.request(registrationsRoute, {
              operation: "register_status",
              ...selector,
            }),
            appRegistrationWire.decodeAppRegistrationStatusResponse,
          ),
        owned: async () =>
          decodeResult(
            await transport.request(registrationsRoute, { operation: "owned_list" }),
            appRegistrationWire.decodeAppOwnedListResponse,
          ),
        rotateSecret: async (clientKey) =>
          decodeResult(
            await transport.request(registrationsRoute, {
              operation: "rotate_secret",
              clientKey,
            }),
            appRegistrationWire.decodeAppSecretRotationResponse,
          ),
      },
      management: {
        execute: async (operation, body) =>
          decodeResult(
            await transport.request(registrationsRoute, { operation, ...body }),
            APP_MANAGEMENT_DECODERS[operation] as (value: unknown) => never,
          ),
      },
    },
  };
}

export function createUnwrappedExtendedResources(
  raw: RawAgentApiExtendedClient,
  unwrap: <T>(result: AgentApiResult<T>) => T,
): AgentApiExtendedClient {
  return {
    actions: {
      prepare: async (request) => unwrap(await raw.actions.prepare(request)),
      withdraw: async (request) => unwrap(await raw.actions.withdraw(request)),
    },
    inbox: {
      read: async (request) => unwrap(await raw.inbox.read(request)),
      dismiss: async (request) => unwrap(await raw.inbox.dismiss(request)),
    },
    threads: {
      follow: async (threadId) => unwrap(await raw.threads.follow(threadId)),
      unfollow: async (threadId) => unwrap(await raw.threads.unfollow(threadId)),
    },
    artifacts: {
      execute: async (request) => unwrap(await raw.artifacts.execute(request)),
    },
    apps: {
      list: async () => unwrap(await raw.apps.list()),
      marketplace: async (input) => unwrap(await raw.apps.marketplace(input)),
      token: async (appKey, input) => unwrap(await raw.apps.token(appKey, input)),
      registrations: {
        status: async (selector) => unwrap(await raw.apps.registrations.status(selector)),
        owned: async () => unwrap(await raw.apps.registrations.owned()),
        rotateSecret: async (clientKey) =>
          unwrap(await raw.apps.registrations.rotateSecret(clientKey)),
      },
      management: {
        execute: async (operation, body) =>
          unwrap(await raw.apps.management.execute(operation, body)),
      },
    },
  };
}
