import { expect, test } from "bun:test";
import { connectionString, privateChannelFixture } from "./helpers/private-channel-fixture";

/**
 * What the web shows of a channel's visibility (task #302): the channel's page and the Chat list say
 * whether it is private, Workspace settings lists an archived private channel as private, and the
 * page says whether the viewer may switch it, by `setChannelVisibility`'s rule.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
test.skipIf(!connectionString)(
  "the page and the lists say a channel's visibility, and the page who may change it",
  async () => {
    const fixture = await privateChannelFixture(connectionString!);
    const { db, ws, people, channels, open, closed, vault } = fixture;
    const page = async (userId: string, channelId: string) => {
      const { visibility, canChangeVisibility } = await channels.open(ws, userId, channelId);
      return { visibility, canChangeVisibility };
    };
    try {
      // The Workspace owner, in the public channel: may make it private.
      expect(await page(people.owner, open.id)).toEqual({
        visibility: "public",
        canChangeVisibility: true,
      });
      // The channels' admin, a plain Workspace member: may not, in either.
      expect(await page(people.insider, open.id)).toEqual({
        visibility: "public",
        canChangeVisibility: false,
      });
      expect(await page(people.insider, closed.id)).toEqual({
        visibility: "private",
        canChangeVisibility: false,
      });
      const listed = await channels.list(ws, people.insider);
      expect(
        Object.fromEntries(
          listed
            .filter((row) => row.id === open.id || row.id === closed.id)
            .map((row) => [row.id, row.visibility]),
        ),
      ).toEqual({ [open.id]: "public", [closed.id]: "private" });

      // Made a Workspace admin, they may, but never in an archived channel.
      await db.workspaceMembership.update({
        where: { workspaceId_userId: { workspaceId: ws, userId: people.insider } },
        data: { role: "admin" },
      });
      expect(await page(people.insider, closed.id)).toEqual({
        visibility: "private",
        canChangeVisibility: true,
      });
      expect(await page(people.insider, vault.id)).toEqual({
        visibility: "private",
        canChangeVisibility: false,
      });
      expect(
        (await channels.archived(ws, people.insider)).map((row) => [row.id, row.visibility]),
      ).toEqual([[vault.id, "private"]]);
    } finally {
      await fixture.dispose();
    }
  },
);
