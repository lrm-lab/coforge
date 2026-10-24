import type { AgentProfileView, AgentUserInfoResponse } from "@lrm/coforge-sdk/agent";

/** `coforge user info <name>`: narrow visible facts for a human or Agent and the visible channels
 * it shares with the caller, paged by `--limit`/`--offset`. The channels are the ones both belong
 * to, so each is one the target has joined and none is archived. */
export function formatUserInfo(
  response: AgentUserInfoResponse,
  page: { name: string; limit?: number; offset?: number } = { name: "<name>" },
): string {
  const { user, memberships } = response;
  const lines = ["## User", ""];
  lines.push(`User: @${user.name}`);
  lines.push(`Kind: ${user.kind}`);
  if (user.kind === "agent" && user.status) lines.push(`Status: ${user.status}`);
  if (user.role && user.role !== "member") lines.push(`Role: ${user.role}`);
  if (user.description) lines.push(`Description: ${user.description}`);
  lines.push(`Display name: ${user.displayName}`);
  if (user.kind === "agent") {
    if (user.computerName) lines.push(`Computer: ${user.computerName}`);
    if (user.runtime) lines.push(`Provider: ${user.runtime}`);
    if (user.model) lines.push(`Model: ${user.model}`);
    if (user.availability) lines.push(`Availability: ${user.availability}`);
  }
  if (user.isSelf) lines.push("Self: yes");
  lines.push("");
  lines.push("### Visible Channel Memberships");
  const limit = page.limit ?? 50;
  const offset = page.offset ?? 0;
  const shown = memberships.slice(offset, offset + limit);
  if (shown.length === 0) lines.push("(none found in inspected visible channels)");
  else
    for (const membership of shown) {
      const status = [
        "public",
        "joined",
        ...(membership.role ? [`channel role=${membership.role}`] : []),
      ];
      lines.push(`${membership.channel} [${[...status, "not archived"].join(", ")}]`);
    }
  const total = memberships.length;
  const past = offset >= total;
  const start = past ? 0 : offset + 1;
  const end = past ? 0 : Math.min(offset + limit, total);
  const footer = [`\nShowing ${start}-${end} of ${total}.`];
  if (!past && end < total)
    footer.push(`More: coforge user info @${page.name} --offset ${end} --limit ${limit}`);
  return `${lines.join("\n")}${footer.join("\n")}\n`;
}

/** `coforge profile show [<target>]` and `coforge profile update`: both return the same
 * discriminated profile view, so they share one renderer. */
export function formatProfile(response: { profile: AgentProfileView }): string {
  const { profile } = response;
  const lines = ["## Profile", ""];
  lines.push(`Username: @${profile.name}`);
  lines.push(`Kind: ${profile.kind}`);
  lines.push(`Display name: ${profile.displayName}`);
  if (profile.description) lines.push(`Description: ${profile.description}`);
  if (profile.role) lines.push(`Role: ${profile.role}`);
  if (profile.kind === "agent") {
    lines.push(`Status: ${profile.status}`);
    if (profile.computerName) lines.push(`Computer: ${profile.computerName}`);
    if (profile.runtime) lines.push(`Provider: ${profile.runtime}`);
    if (profile.model) lines.push(`Model: ${profile.model}`);
    if (profile.availability) lines.push(`Availability: ${profile.availability}`);
  }
  if (profile.isSelf) lines.push("Self: yes");
  lines.push("");
  if (profile.kind === "human") {
    lines.push("### Created Agents");
    if (profile.createdAgents.length === 0) lines.push("(none)");
    else
      for (const agent of profile.createdAgents) lines.push(`- @${agent.name} (${agent.status})`);
  } else {
    lines.push(
      profile.creator
        ? `Creator: @${profile.creator.name} (${profile.creator.displayName})`
        : "Creator: (unknown)",
    );
  }
  return lines.join("\n");
}
