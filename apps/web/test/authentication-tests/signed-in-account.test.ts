import { expect, test } from "bun:test";

import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { signedInAccount } from "#src/server/auth/signed-in-account.server";

// The account "Signed in as ..." names, and whether that person still has to be asked for a
// name. The signed session says who signed in; the names come from the database. A person has
// been asked for a name once their first sign-in welcomed them (`welcomedAt`).

const welcomedAt = new Date("2026-10-01T00:00:00Z");

type Row = { displayName: string; username: string; welcomedAt: Date | null } | null;

function databaseWith(row: Row) {
  return { user: { findUnique: async () => row } } as never;
}

const session = {
  id: "user-1",
  email: null,
  username: "ada",
  name: "Provider Ada",
  authingSub: "authing-ada",
};

test("an account with an email is named by it, whatever its names are", async () => {
  const db = databaseWith({ displayName: "Ada Lovelace", username: "ada", welcomedAt });

  expect(await signedInAccount(db, { ...session, email: "ada@example.com" })).toEqual({
    account: "ada@example.com",
    named: true,
  });
});

test("an account with no email is named by the stored name, never by the provider's or an @username", async () => {
  const db = databaseWith({ displayName: "Ada Lovelace", username: "ada", welcomedAt });

  expect(await signedInAccount(db, session)).toEqual({ account: "Ada Lovelace", named: true });
});

test("a person who has not been asked for a name is not named yet", async () => {
  const db = databaseWith({ displayName: "Ada Lovelace", username: "ada", welcomedAt: null });

  expect(await signedInAccount(db, session)).toEqual({ account: "Ada Lovelace", named: false });
});

test("a session whose user is gone is shown as unnamed, never by its username, and still has to be named", async () => {
  expect(await signedInAccount(databaseWith(null), session)).toEqual({
    account: UNNAMED_PERSON_NAME,
    named: false,
  });
});
