import { test } from "bun:test";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { hideUsernamesRun } from "./helpers/hide-usernames-e2e";

/**
 * A person is shown by their name, never by their `@username`. Settings → Account edits one
 * required display name (the username is not shown or editable); Settings → Members, its Invite
 * dialog (the join link alone, no invite by username) and the Members directory list people by
 * their names. Channels and Search: `e2e-hide-usernames-channels.e2e.ts`.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database, seeded by `hideUsernamesRun`.
 */
test(
  "Settings and the Members directory show people by their names, never a username",
  () =>
    hideUsernamesRun(
      "settings",
      async ({
        browser,
        evaluate,
        waitFor,
        db,
        base,
        showsNoUsername,
        mainText,
        mainButton,
        hydrated,
        check,
        shoot,
      }) => {
        const saved = `document.querySelector("main [role=status]")?.textContent.includes("Profile saved")`;
        /** The edit form is up once it offers Save. */
        const editing = `${mainButton("Save")} !== undefined`;
        // Settings → Account: the read view shows the one name and no username.
        await browser("open", `${base}/settings?section=account`);
        await waitFor(hydrated(mainButton("Edit")));
        let text = await mainText();
        check("account: read view lists the Display name", /Display name/.test(text));
        check("account: read view has no Username row", !/Username/i.test(text));
        check("account: read view shows no @username", showsNoUsername(text));
        check("account: the display name is the name", /Dev Viewer/.test(text));
        await shoot("settings-profile");

        // The edit form: one required Display name, and no username.
        await browser("eval", `${mainButton("Edit")}.click()`);
        await waitFor(editing);
        text = await mainText();
        check("account: edit form has a Display name field", /Display name/.test(text));
        check("account: edit form does not call the display name optional", !/Optional/.test(text));
        check(
          "account: edit form has no Username field or 'cannot be changed' copy",
          !/Username|cannot be changed/i.test(text),
        );
        check("account: edit form shows no @username", showsNoUsername(text));
        await shoot("settings-profile-edit");

        // A name the rule refuses says why where it is typed, and cannot be saved.
        const saveDisabled = `${mainButton("Save")}?.disabled === true`;
        for (const [typed, reason] of [
          ["System", "You can't use this name."],
          ["@bot", "You can't use this name."],
          ["a".repeat(81), "Use 80 characters or fewer."],
          // Blank: an empty fill is ignored by the browser tool, and a space normalizes to nothing.
          [" ", "Enter your display name."],
        ] as const) {
          await browser("find", "label", "Display name", "fill", typed);
          await waitFor(
            `document.querySelector("main")?.innerText.includes(${JSON.stringify(reason)})`,
          );
          check(
            `account: a display name refused as "${reason}" cannot be saved`,
            await evaluate<boolean>(saveDisabled),
          );
        }
        // The name is normalized on save.
        await browser("find", "label", "Display name", "fill", "  Dev   Viewer  Prime ");
        await browser("eval", `${mainButton("Save")}.click()`);
        await waitFor(saved);
        let viewer = await db.user.findUniqueOrThrow({ where: { id: DEV_BROWSER_USER.id } });
        check(
          "account: the display name is stored trimmed and single-spaced",
          viewer.displayName === "Dev Viewer Prime",
        );

        // A changed name is the name wherever a person is shown.
        await browser("eval", `${mainButton("Edit")}.click()`);
        await waitFor(editing);
        await browser("find", "label", "Display name", "fill", "Dee");
        await browser("eval", `${mainButton("Save")}.click()`);
        await waitFor(saved);
        viewer = await db.user.findUniqueOrThrow({ where: { id: DEV_BROWSER_USER.id } });
        check("account: a display name is stored", viewer.displayName === "Dee");
        await shoot("settings-profile-saved");

        // Settings → Members: people by their names and no @username; the Invite dialog holds the
        // join link alone.
        await browser("open", `${base}/settings?section=members`);
        await waitFor(`Boolean(document.querySelector('main ul[aria-label="Members"] li'))`);
        text = await mainText();
        for (const name of ["Ada Lovelace", "Amazing Grace", "Dee"])
          check(`members panel: lists ${name}`, text.includes(name));
        check("members panel: shows no username", showsNoUsername(text));
        check("members panel: no row carries an @handle", !/@[a-z0-9-]/i.test(text));
        check(
          "members panel: has no pending invitations section",
          !/Pending invitations/.test(text),
        );
        await shoot("settings-members");

        await waitFor(hydrated(mainButton("Invite")));
        await browser("eval", `${mainButton("Invite")}.click()`);
        await waitFor(`document.querySelector('[role="dialog"] input')?.value?.includes("/join/")`);
        const dialog = await evaluate<{ text: string; tabs: number }>(
          `({ text: document.querySelector('[role="dialog"]').innerText, tabs: document.querySelectorAll('[role="dialog"] [role="tab"]').length })`,
        );
        check(
          "invite dialog: has no tabs and no invite by username",
          dialog.tabs === 0 && !/username/i.test(dialog.text),
        );
        await shoot("invite-dialog");
        await browser("press", "Escape");

        // The Members directory: a card carries a name only.
        await browser("open", `${base}/members?memberType=human`);
        await waitFor(`document.querySelectorAll('main [role="row"] h2').length >= 3`);
        text = await mainText();
        check(
          "members directory: lists people by name",
          ["Ada Lovelace", "Amazing Grace"].every((name) => text.includes(name)),
        );
        check("members directory: shows no username", showsNoUsername(text));
        check("members directory: no card carries an @handle", !/@[a-z0-9-]/i.test(text));
        await shoot("members-directory");
      },
    ),
  180_000,
);
