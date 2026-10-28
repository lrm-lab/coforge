// The page's attachment videos: the messages' players and an open preview's. It runs in the
// browser alone (a conversation is never server-rendered).
const videos = new Set<HTMLVideoElement>();
let observer: IntersectionObserver | undefined;

const pauseOthers = (event: Event) => {
  for (const video of videos) if (video !== event.currentTarget && !video.paused) video.pause();
};

/**
 * Plays `element` as the page's one video: playing it pauses any other, and scrolling it all the
 * way off screen pauses it. The returned function takes it back out.
 */
export function joinExclusivePlayback(element: HTMLVideoElement) {
  observer ??= new IntersectionObserver((changes) => {
    for (const change of changes) {
      const video = change.target as HTMLVideoElement;
      // Picture-in-picture keeps playing once its message has scrolled away.
      const pictureInPicture = document.pictureInPictureElement === video;
      if (!change.isIntersecting && !video.paused && !pictureInPicture) video.pause();
    }
  });
  videos.add(element);
  observer.observe(element);
  element.addEventListener("play", pauseOthers);
  return () => {
    element.removeEventListener("play", pauseOthers);
    observer?.unobserve(element);
    videos.delete(element);
    if (videos.size > 0) return;
    observer?.disconnect();
    observer = undefined;
  };
}
