import type { ProfileShowInvocation } from "../index";
import type { ProfileUpdateInvocation } from "./profile-update";
import type { MessageTransport } from "./message-transport";
import { formatProfile } from "./user-format";

export async function runProfileCommand(
  invocation: ProfileShowInvocation | ProfileUpdateInvocation,
  transport: MessageTransport,
) {
  if (invocation.command === "profile-show") {
    if (!transport.profileShow) throw new Error("Profile transport is unavailable");
    const result = await transport.profileShow(invocation.target);
    return invocation.json ? result : formatProfile(result);
  }
  if (invocation.command === "profile-update") {
    if (!transport.profileUpdate) throw new Error("Profile transport is unavailable");
    const result = await transport.profileUpdate({
      displayName: invocation.displayName,
      description: invocation.description,
    });
    return invocation.json ? result : formatProfile(result);
  }
}
