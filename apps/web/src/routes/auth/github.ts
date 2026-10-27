import { createFileRoute } from "@tanstack/react-router";

import { githubSignInStartHandler } from "#src/server/auth/github-sign-in-http.server";

export const Route = createFileRoute("/auth/github")({
  server: {
    handlers: {
      GET: githubSignInStartHandler,
    },
  },
});
