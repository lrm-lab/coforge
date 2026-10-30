import { createFileRoute } from "@tanstack/react-router";

import { DeviceVerifyPage } from "#src/features/device-auth/device-verify-page";
import { getDeviceVerifyUser } from "#src/features/device-auth/device-auth.functions";

/**
 * Where a Computer's `login` sends the person sitting in front of it. Deliberately outside
 * the Workspace layout: someone arriving here may have no Workspace selected yet, and the page has to work as a
 * standalone destination pasted from a terminal.
 *
 * The loader redirects to /login when there is no session, so signing in first is a property of
 * the route rather than an instruction the user has to follow.
 */
export const Route = createFileRoute("/oauth/verify")({
  loader: async () => ({ user: await getDeviceVerifyUser() }),
  component: Verify,
});

function Verify() {
  const { user } = Route.useLoaderData();
  // The code is always typed from the Computer's screen, never taken from the link: a link someone
  // sent with their code in it must not be one click from signing their Computer in as you.
  return <DeviceVerifyPage account={user.account} />;
}
