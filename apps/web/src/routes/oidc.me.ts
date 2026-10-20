import { createFileRoute } from "@tanstack/react-router";
import { oidcUserInfo } from "#src/server/authorization-server/http.server";

// Login with CoForge's UserInfo endpoint (`USERINFO_ENDPOINT_PATH`); OIDC Core §5.3.1 allows both
// methods.
export const Route = createFileRoute("/oidc/me")({
  server: {
    handlers: {
      GET: ({ request }): Promise<Response> => oidcUserInfo(request),
      POST: ({ request }): Promise<Response> => oidcUserInfo(request),
    },
  },
});
