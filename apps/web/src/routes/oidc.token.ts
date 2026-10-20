import { createFileRoute } from "@tanstack/react-router";
import { oidcToken } from "#src/server/authorization-server/http.server";

// Login with CoForge's token endpoint (`TOKEN_ENDPOINT_PATH`): an app redeems a code.
export const Route = createFileRoute("/oidc/token")({
  server: { handlers: { POST: ({ request }): Promise<Response> => oidcToken(request) } },
});
