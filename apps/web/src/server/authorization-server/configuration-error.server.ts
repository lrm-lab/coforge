/** The authorization server's configuration is unusable, which fails the boot. Messages name the
 * variable (and a key's index) and what is wrong, never a configured value. */
export class AuthorizationServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationServerConfigError";
  }
}
