import {
  PROFILE_IMAGE_STYLES,
  publicImageUrl,
  publicImageUrlOrFallback,
  versionedImagePath,
  type PublicImageUrlResolver,
} from "#src/server/files/public-image-delivery.server";

/**
 * Where the browser reads an app's logo: the image CDN when this deployment has one, at the icon
 * size, so anyone shown the app (the consent page, later people of other Workspaces) can load it;
 * otherwise the app's own route, which serves people of a Workspace where it is installed,
 * versioned by the object. `null` without a logo: the surface shows the monogram.
 */
export function appLogoUrl(
  ownerWorkspaceId: string,
  appKey: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
): string | null {
  return publicImageUrlOrFallback(
    objectKey,
    PROFILE_IMAGE_STYLES.icon,
    (key) => versionedImagePath(`/api/workspaces/${ownerWorkspaceId}/apps/${appKey}/logo`, key),
    publicUrl,
  );
}

/** A new logo's object, under its Workspace's prefix like the Workspace's other images; deleting
 * the Workspace removes it among the image keys its rows name (`WorkspaceDeletion`). */
export function appLogoObjectKey(ownerWorkspaceId: string, appKey: string): string {
  return `workspaces/${ownerWorkspaceId}/apps/${appKey}/logos/${crypto.randomUUID()}/original`;
}
