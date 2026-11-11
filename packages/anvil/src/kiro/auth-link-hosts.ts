/**
 * The hosts a Kiro device-code link may point at. The link is shown to a person in the web dialog
 * and clicked there, so a host kiro-cli printed without us knowing it is refused rather than
 * forwarded: terminal output is not a source of trusted links, and a free sign-in lets the provider
 * be whichever one the person picked (task #615).
 *
 * An identity-center sign-in has always stayed on the identity center's own AWS hosts. A free one
 * adds Kiro's own login service and the two social providers kiro-cli's Builder ID flow offers;
 * the first real free login records the host it actually printed, so this list can be tightened to
 * what kiro-cli really uses.
 */
export type KiroLinkFlow = "identity_center" | "free";

/** The AWS device-authorization host, in every partition `kiro-cli` prints. */
const AWS_DEVICE_HOST = /^device\.sso\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/u;
/** AWS's access-portal host, which an identity-center start URL lives on. */
const AWSAPPS_HOST = /(^|\.)awsapps\.com$/u;
/** Kiro's own sign-in service. */
const KIRO_HOST = /(^|\.)kiro\.dev$/u;
/** Google's account host, for a Builder ID sign-in through Google. */
const GOOGLE_HOST = /^accounts\.google\.com$/u;
/** GitHub's host, for a Builder ID sign-in through GitHub. */
const GITHUB_HOST = /^(?:github\.com|www\.github\.com)$/u;

/** Whether this parsed URL is one the dialog may offer for a sign-in of this kind. */
export function kiroDeviceLinkAllowed(flow: KiroLinkFlow, url: URL): boolean {
  // Never a link with a credential in it, and never anything but HTTPS: the person clicks it.
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (AWS_DEVICE_HOST.test(url.hostname) || AWSAPPS_HOST.test(url.hostname)) return true;
  if (flow === "identity_center") return false;
  return (
    KIRO_HOST.test(url.hostname) || GOOGLE_HOST.test(url.hostname) || GITHUB_HOST.test(url.hostname)
  );
}
