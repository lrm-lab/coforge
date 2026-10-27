import { createFileRoute } from "@tanstack/react-router";

import { githubSignInCallbackHandler } from "#src/server/auth/github-sign-in-http.server";

export const Route = createFileRoute("/auth/github/callback")({
  server: {
    handlers: {
      GET: githubSignInCallbackHandler,
    },
  },
});
