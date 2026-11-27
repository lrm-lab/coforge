import {
  agentApiRoutes,
  agentReadConfirmationSchema,
  agentReadPageRequestSchema,
} from "@lrm/coforge-sdk/agent";
import { badRequest } from "./agent-proxy-body";
import { exactPath } from "./agent-proxy-paths";
import { forwardResponse } from "./agent-proxy-response";
import { defineRoute } from "./agent-proxy-route";

export const READ_CONFIRMATION_PROXY_ROUTES = (["page", "confirm"] as const).map((operation) => {
  const route = agentApiRoutes.proxy.readConfirmation[operation];
  return defineRoute({
    family: `agent-api/read-${operation}`,
    method: route.method,
    match: exactPath(route.path),
    body: "json-object",
    maxBodyBytes: 96 * 1024,
    handler: "agentReadConfirmation",
    parse: ({ fields }) => {
      if (operation === "page") {
        const page = agentReadPageRequestSchema.safeParse(fields);
        return page.success ? { operation, body: page.data } : badRequest();
      }
      const confirm = agentReadConfirmationSchema.safeParse(fields);
      return confirm.success ? { operation, body: confirm.data } : badRequest();
    },
    respond: forwardResponse,
  });
});
