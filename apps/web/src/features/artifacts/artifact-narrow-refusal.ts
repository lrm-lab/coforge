import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

export const lossChanged = (cause: unknown) =>
  isAppError(cause) && cause.errorId === "artifact-loss-changed";

export function narrowRefusalMessage(cause: unknown): string | undefined {
  if (!isAppError(cause)) return undefined;
  switch (cause.errorId) {
    case "artifact-home-unseen":
      return m.av_vis_narrow_unseen();
    case "artifact-home-gone":
      return m.av_vis_narrow_home_gone();
    case "artifact-access-tier":
      return m.av_vis_narrow_no_home();
    case "artifact-author-not-member":
      return m.av_vis_narrow_author_not_member();
    case "artifact-author-cannot-see":
      return m.av_vis_narrow_author_cannot_see();
    default:
      return undefined;
  }
}
