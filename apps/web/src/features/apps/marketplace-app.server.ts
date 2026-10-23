import type {
  MarketplaceListing,
  SharedAppInfo,
} from "#src/server/app-marketplace/app-installations.server";
import { appLogoUrl } from "#src/server/apps/app-logo.server";
import type { MarketplaceApp, MarketplaceAppInfo } from "./app-marketplace.functions";

/** The host of a stored URL; `null` for none or one that is not a URL. */
function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The hosts of the callback URLs, once each, in the order given; a value that is not a URL is
 * skipped. */
function callbackDomains(redirectUris: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const uri of redirectUris) {
    try {
      hosts.add(new URL(uri).host);
    } catch {
      // Stored URIs are validated; skip anything that is not.
    }
  }
  return [...hosts];
}

/** An app as the Marketplace and the share page show it: the host names worked out once, the
 * logo as a URL (through the link's own route for a share page, `shareToken`), and the ids a
 * browser has no use for left out. */
export function toMarketplaceAppInfo(
  {
    appId: _appId,
    ownerWorkspaceId,
    logoObjectKey,
    redirectUris,
    publishedAt,
    ...app
  }: SharedAppInfo,
  shareToken?: string,
): MarketplaceAppInfo {
  return {
    ...app,
    homepageHost: hostOf(app.homepageUrl),
    callbackDomains: callbackDomains(redirectUris),
    logoUrl: appLogoUrl(ownerWorkspaceId, app.key, logoObjectKey, undefined, shareToken),
    publishedAt: publishedAt?.toISOString() ?? null,
  };
}

/** A listing as the Marketplace tab shows it. */
export function toMarketplaceApp(
  listing: MarketplaceListing,
  approvesOnInstall: boolean,
): MarketplaceApp {
  return { ...toMarketplaceAppInfo(listing), installed: listing.installed, approvesOnInstall };
}
