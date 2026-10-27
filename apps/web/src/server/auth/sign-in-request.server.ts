import { clientAddress, publicOrigin } from "#src/server/http/public-origin.server";
import { readSignInConfigOrNull } from "./config.server";

/**
 * What every sign-in request needs of its environment: the Authing app and session secret (`null`
 * when the deployment lacks them, so the sign-in fails like any other failure), whether the browser
 * reached the site over HTTPS (for the cookies set), and the client's address (for the limits).
 */
export async function signInRequestContext(request: Request) {
  return {
    signIn: await readSignInConfigOrNull(process.env),
    secure: publicOrigin(request).startsWith("https:"),
    clientAddress: clientAddress(request),
  };
}
