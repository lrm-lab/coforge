import { createServerFn } from "@tanstack/react-start";
import { TERMINAL_MAX_CHUNK_BYTES } from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { AppError } from "#src/lib/app-error";
import { createProductionComputerTerminalService } from "#src/server/computers/computer-terminal-production.server";
import type { TerminalViewer } from "#src/server/computers/computer-terminal.server";
import { computerIdInputSchema } from "./computer.schemas";
import {
  activateComputerTerminalAttachInputSchema,
  closeComputerTerminalInputSchema,
  detachComputerTerminalInputSchema,
  prepareComputerTerminalAttachInputSchema,
  refreshComputerTerminalSubscriptionInputSchema,
  resizeComputerTerminalInputSchema,
  sendComputerTerminalInputSchema,
  setComputerTerminalEnabledInputSchema,
} from "./computer-terminal.schemas";

function viewerFromContext(context: WorkspaceUserContext): TerminalViewer {
  return {
    userId: context.user.id,
    workspaceId: context.workspaceId,
    loginGeneration: context.loginGeneration,
    devSkipAuth: context.devSkipAuth,
  };
}

function decodeBase64Bytes(encoded: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new AppError("INVALID_INPUT");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.byteLength < 1 || bytes.byteLength > TERMINAL_MAX_CHUNK_BYTES) {
    throw new AppError("INVALID_INPUT");
  }
  return bytes;
}

export const getComputerTerminalStatus = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(computerIdInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    return createProductionComputerTerminalService(context.db).readStatus(
      viewerFromContext(context),
      data.computerId,
    );
  });

export const setComputerTerminalEnabled = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(setComputerTerminalEnabledInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    return createProductionComputerTerminalService(context.db).setEnabled(
      viewerFromContext(context),
      data.computerId,
      data.enabled,
    );
  });

export const prepareComputerTerminalAttach = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(prepareComputerTerminalAttachInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    return createProductionComputerTerminalService(context.db).prepareAttach(
      viewerFromContext(context),
      data,
    );
  });

export const activateComputerTerminalAttach = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(activateComputerTerminalAttachInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    await createProductionComputerTerminalService(context.db).activateAttach(
      viewerFromContext(context),
      data,
    );
    return { activated: true as const };
  });

export const refreshComputerTerminalSubscription = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(refreshComputerTerminalSubscriptionInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    return createProductionComputerTerminalService(context.db).refreshSubscription(
      viewerFromContext(context),
      data,
    );
  });

export const sendComputerTerminalInput = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(sendComputerTerminalInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    return createProductionComputerTerminalService(context.db).sendInput(
      viewerFromContext(context),
      {
        computerId: data.computerId,
        sessionId: data.sessionId,
        attachId: data.attachId,
        attachGeneration: data.attachGeneration,
        inputSeq: data.inputSeq,
        bytes: decodeBase64Bytes(data.dataBase64),
      },
    );
  });

export const resizeComputerTerminal = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(resizeComputerTerminalInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    await createProductionComputerTerminalService(context.db).resize(
      viewerFromContext(context),
      data,
    );
    return { resized: true as const };
  });

export const detachComputerTerminal = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(detachComputerTerminalInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    await createProductionComputerTerminalService(context.db).detach(
      viewerFromContext(context),
      data,
    );
    return { detached: true as const };
  });

export const closeComputerTerminal = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(closeComputerTerminalInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    await createProductionComputerTerminalService(context.db).close(
      viewerFromContext(context),
      data,
    );
    return { closed: true as const };
  });
