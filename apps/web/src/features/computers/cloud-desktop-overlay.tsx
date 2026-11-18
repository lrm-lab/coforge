import { useEffect } from "react";
import { createPortal } from "react-dom";

import { DesktopStreamSurface } from "./desktop-stream-surface";

/** In-page maximized cloud desktop (Computer Open desktop / action cards on a phone). */
export function CloudDesktopOverlay({
  url,
  title,
  onClose,
}: {
  url: string;
  title: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <DesktopStreamSurface
      phase="maximized"
      url={url}
      title={title}
      miniBox={null}
      allowMinimize={false}
      onCollapse={onClose}
      onWake={() => {}}
      onSleep={onClose}
    />,
    document.body,
  );
}
