import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { ImageX } from "@untitledui/icons";
import { Skeleton } from "#src/components/ui/skeleton";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export type ImageStatus = "loading" | "loaded" | "failed";

/**
 * The one look of a conversation image: a pulsing skeleton while it loads, the image once it has,
 * and a labelled failed box when it cannot be loaded. The frame keeps the caller's box in every
 * state (`className` sizes it), so nothing jumps when the image arrives. The skeleton is filled
 * a step darker than the text skeletons: a whole image box in `bg-secondary` is close to the white
 * it sits on and reads as an empty frame.
 */
export function ImageFrame({
  status,
  src,
  alt,
  className,
  style,
  imgClassName,
  skeletonClassName,
  failed,
  onLoad,
  onError,
  imgRef,
}: {
  status: ImageStatus;
  src: string;
  alt: string;
  /** Sizes the frame; also carries its rounding and ring, so the three states share them. */
  className?: string;
  /** Sizes the frame where a class cannot, e.g. to an image's known final box. */
  style?: CSSProperties;
  imgClassName?: string;
  /** Overrides how the skeleton fills the frame (it covers it by default). */
  skeletonClassName?: string;
  /** Replaces the failed box's icon, e.g. with the file-type icon. */
  failed?: ReactNode;
  onLoad?: () => void;
  onError?: () => void;
  imgRef?: Ref<HTMLImageElement>;
}) {
  if (status === "failed")
    return (
      <span
        role="img"
        aria-label={m.conversation_image_failed()}
        style={style}
        className={cn(
          "relative flex items-center justify-center overflow-hidden bg-secondary text-fg-quaternary",
          className,
        )}
      >
        {failed ?? <ImageX aria-hidden="true" className="size-6" />}
      </span>
    );
  return (
    <span style={style} className={cn("relative block overflow-hidden", className)}>
      {status === "loading" && (
        <Skeleton
          className={cn(
            "pointer-events-none absolute inset-0 rounded-[inherit] bg-quaternary motion-safe:animate-pulse",
            skeletonClassName,
          )}
        />
      )}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={onLoad}
        onError={onError}
        className={cn(imgClassName, status === "loading" && "opacity-0")}
      />
    </span>
  );
}

/**
 * Owns an image's load state. `fallbackSrc` (the authenticated original behind a signed preview
 * URL) is tried once when `src` fails, before the image counts as failed; `onFailed` lets a
 * surface swap in its own non-image presentation. A cached image can finish loading before React
 * attaches `onLoad`, so the element is checked before the first paint.
 *
 * A new `src` for an image already shown is the same picture under a fresh signature (one
 * component is one attachment): the loaded picture stays up while the new URL loads off-screen,
 * and is swapped once it has, so a re-read never drops a visible image back to its skeleton.
 */
export function LoadingImage({
  src,
  fallbackSrc,
  onFailed,
  ...frame
}: {
  src: string;
  fallbackSrc?: string;
  onFailed?: () => void;
} & Pick<
  ComponentProps<typeof ImageFrame>,
  "alt" | "className" | "style" | "imgClassName" | "skeletonClassName" | "failed"
>) {
  const [state, setState] = useState<{
    src: string;
    fallback: boolean;
    status: ImageStatus;
    /** The URL still on screen while `src` loads off-screen. */
    shown?: string;
  }>({ src, fallback: false, status: "loading" });
  const current = state.fallback && fallbackSrc ? fallbackSrc : state.src;
  if (state.src !== src)
    setState({
      src,
      fallback: false,
      status: "loading",
      shown: state.shown ?? (state.status === "loaded" ? current : undefined),
    });
  const img = useRef<HTMLImageElement>(null);
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  const fail = () => {
    if (!state.fallback && fallbackSrc && fallbackSrc !== src)
      setState({ src, fallback: true, status: "loading" });
    else {
      setState({ src, fallback: state.fallback, status: "failed" });
      onFailedRef.current?.();
    }
  };
  const failRef = useRef(fail);
  failRef.current = fail;
  const { shown } = state;
  useLayoutEffect(() => {
    if (shown) return;
    const el = img.current;
    if (!el?.complete) return;
    if (el.naturalWidth > 0) setState((prev) => ({ ...prev, status: "loaded" }));
    else failRef.current();
  }, [current, shown]);
  useEffect(() => {
    if (!shown) return;
    // Loaded off-screen; a failure hands the URL to the ordinary path, fallback included.
    const probe = new Image();
    const settle = (loaded: boolean) =>
      setState((prev) =>
        prev.src === src
          ? { ...prev, shown: undefined, status: loaded ? "loaded" : prev.status }
          : prev,
      );
    probe.onload = () => settle(true);
    probe.onerror = () => settle(false);
    probe.src = current;
    return () => {
      probe.onload = null;
      probe.onerror = null;
      probe.src = "";
    };
  }, [shown, current, src]);
  if (shown) return <ImageFrame {...frame} src={shown} status="loaded" imgRef={img} />;
  return (
    <ImageFrame
      {...frame}
      src={current}
      status={state.status}
      imgRef={img}
      onLoad={() => setState((prev) => ({ ...prev, status: "loaded" }))}
      onError={fail}
    />
  );
}
