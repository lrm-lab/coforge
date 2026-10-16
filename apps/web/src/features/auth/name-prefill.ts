import { checkPersonName } from "#src/features/profiles/person-name";
import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";

export { UNNAMED_PERSON_NAME };

/**
 * What the name field starts with: the name the sign-in provider reported, when it reads as one.
 * Providers fill that field with whatever the account was made with, and a phone number or an
 * email address is not a name, so those (and anything the field would refuse) leave it empty.
 */
export function namePrefill(providerName: string): string {
  const checked = checkPersonName(providerName);
  if (!checked.ok) return "";
  return looksLikePhoneNumber(checked.name) || looksLikeEmail(checked.name) ? "" : checked.name;
}

/** Six to fifteen digits (E.164's longest is fifteen), with a leading `+` and the separators
 * people write numbers with. */
function looksLikePhoneNumber(value: string): boolean {
  return /^\+?\d{6,15}$/.test(value.replace(/[\s().-]/g, ""));
}

function looksLikeEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value);
}

/**
 * The display name a new account is created with, so a person always has a name and is never
 * shown by their username (Slack requires a name the same way): the provider's name, else its
 * nickname, else the local part of the email, each only when it reads as a name; else
 * `UNNAMED_PERSON_NAME`.
 */
export function initialDisplayName(profile: {
  name?: string | null;
  nickname?: string | null;
  email?: string | null;
}): string {
  const candidates = [profile.name, profile.nickname, profile.email?.split("@")[0]];
  for (const candidate of candidates) {
    const name = namePrefill(candidate ?? "");
    if (name) return name;
  }
  return UNNAMED_PERSON_NAME;
}
