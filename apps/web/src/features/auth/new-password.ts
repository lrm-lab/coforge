/**
 * What a new password must look like before Authing is asked, shared by the reset page, which
 * checks what was typed, and the server, which judges it again. Authing's own policy may ask for
 * more; what it refuses is shown as such.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export function isNewPassword(value: string): boolean {
  return value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH;
}
