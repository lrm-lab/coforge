import type { ChannelCommand } from "@lrm/coforge-sdk/internal";
import {
  formatChannelAddMember,
  formatChannelArchive,
  formatChannelCreate,
  formatChannelInfo,
  formatChannelJoin,
  formatChannelLeave,
  formatChannelMembers,
  formatChannelRemoveMember,
  formatChannelUpdate,
} from "./channel-format";
import type { ChannelManagementInvocation } from "./channel-args";

/** The transport call `channel ...` management makes. */
export type ChannelCommandTransport = {
  channel?(command: Omit<ChannelCommand, "idempotencyKey">): Promise<unknown>;
};

/** Runs a `channel` management command and returns what it prints. */
export async function runChannelCommand(
  transport: ChannelCommandTransport,
  invocation: ChannelManagementInvocation,
): Promise<unknown> {
  if (!transport.channel) throw new Error("Channel management transport is unavailable");
  const { channel } = invocation;
  const response = (await transport.channel(channel)) as Record<string, unknown>;
  if (invocation.json) return response;
  switch (channel.operation) {
    case "info":
      return formatChannelInfo(response as Parameters<typeof formatChannelInfo>[0]);
    case "members":
      return formatChannelMembers(response as Parameters<typeof formatChannelMembers>[0]);
    case "join":
      return formatChannelJoin(response as Parameters<typeof formatChannelJoin>[0]);
    case "leave":
      return formatChannelLeave(response as Parameters<typeof formatChannelLeave>[0]);
    case "create":
      return formatChannelCreate(response as Parameters<typeof formatChannelCreate>[0]);
    case "update":
      return formatChannelUpdate(response as Parameters<typeof formatChannelUpdate>[0]);
    case "archive":
    case "unarchive":
      return formatChannelArchive(response as Parameters<typeof formatChannelArchive>[0]);
    case "add-member":
      return formatChannelAddMember(response as Parameters<typeof formatChannelAddMember>[0]);
    case "remove-member": {
      const removeResponse = response as { wasMember: boolean };
      return formatChannelRemoveMember(
        channel.target!,
        (channel.user ?? channel.agent)!,
        removeResponse.wasMember,
      );
    }
  }
}
