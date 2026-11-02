// The attachment players on the page, video and audio: the messages' players and a preview's. It
// runs in the browser alone (a conversation is never server-rendered).
const players = new Set<HTMLMediaElement>();
let observer: IntersectionObserver | undefined;

const pauseOthers = (event: Event) => {
  for (const player of players)
    if (player !== event.currentTarget && !player.paused) player.pause();
};

/**
 * Plays `element` as the page's one video or audio file: playing it pauses any other. A video
 * scrolled all the way off screen pauses too; an audio file plays on while its message is still
 * rendered, as a voice message is listened to while reading on. The returned function takes it
 * back out.
 */
export function joinExclusivePlayback(element: HTMLMediaElement) {
  players.add(element);
  element.addEventListener("play", pauseOthers);
  if (element instanceof HTMLVideoElement) watchScroll(element);
  return () => {
    element.removeEventListener("play", pauseOthers);
    observer?.unobserve(element);
    players.delete(element);
    if (players.size > 0) return;
    observer?.disconnect();
    observer = undefined;
  };
}

function watchScroll(element: HTMLVideoElement) {
  observer ??= new IntersectionObserver((changes) => {
    for (const change of changes) {
      const player = change.target as HTMLMediaElement;
      // Picture-in-picture keeps playing once its message has scrolled away.
      const pictureInPicture = document.pictureInPictureElement === player;
      if (!change.isIntersecting && !player.paused && !pictureInPicture) player.pause();
    }
  });
  observer.observe(element);
}
