import { useEffect, type RefObject } from "react";

/** Particles per click, how far they go (CSS px) and how long they last (ms): the designer's v7. */
const COUNT = 12;
const REACH = 46;
const LIFE = 480;

type Burst = {
  x: number;
  y: number;
  born: number;
  particles: { angle: number; reach: number; radius: number }[];
};

/**
 * The homepage's pointer effects (jing's v8): a soft white light that trails the mouse, and where
 * it clicks a quick burst of white particles of different sizes with a faint purple glow. Mouse and
 * pen only, and nothing at all for someone who asked for less motion (the stylesheet also hides
 * both then). Everything is undone when the page goes.
 */
export function useLandingPointerEffects(
  glowRef: RefObject<HTMLDivElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
) {
  useEffect(() => {
    const glow = glowRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!glow || !canvas || !context) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const fine = matchMedia("(pointer: fine)");
    const controller = new AbortController();
    const { signal } = controller;
    // The light and the particles each run their own frame loop.
    let lightFrame = 0;
    let sparkFrame = 0;

    // ---- the light: it trails the pointer a little, so it reads as light rather than a cursor ----
    let x = innerWidth / 2;
    let y = innerHeight / 2;
    let gx = x;
    let gy = y;
    let following = false;
    const follow = () => {
      gx += (x - gx) * 0.18;
      gy += (y - gy) * 0.18;
      glow.style.transform = `translate3d(${gx}px, ${gy}px, 0)`;
      following = Math.abs(x - gx) > 0.3 || Math.abs(y - gy) > 0.3;
      if (following) lightFrame = requestAnimationFrame(follow);
    };
    window.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerType === "touch" || !fine.matches) return;
        x = event.clientX;
        y = event.clientY;
        glow.setAttribute("data-on", "");
        if (!following) {
          following = true;
          lightFrame = requestAnimationFrame(follow);
        }
      },
      { signal },
    );
    document.documentElement.addEventListener(
      "pointerleave",
      () => glow.removeAttribute("data-on"),
      {
        signal,
      },
    );

    // ---- the particles: thrown out from the click, easing out as they fade ----
    let bursts: Burst[] = [];
    let running = false;
    const size = () => {
      const ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = innerWidth * ratio;
      canvas.height = innerHeight * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    size();
    window.addEventListener("resize", size, { signal });
    const draw = (now: number) => {
      context.clearRect(0, 0, innerWidth, innerHeight);
      bursts = bursts.filter((burst) => now - burst.born < LIFE);
      context.fillStyle = "#ffffff";
      context.shadowColor = "rgba(124, 92, 255, 0.95)";
      context.shadowBlur = 8;
      for (const burst of bursts) {
        const t = (now - burst.born) / LIFE;
        const out = REACH * (1 - (1 - t) ** 3);
        context.globalAlpha = (1 - t) ** 1.2;
        for (const { angle, reach, radius } of burst.particles) {
          context.beginPath();
          context.arc(
            burst.x + Math.cos(angle) * out * reach,
            burst.y + Math.sin(angle) * out * reach,
            radius * (1 - t * 0.35),
            0,
            Math.PI * 2,
          );
          context.fill();
        }
      }
      context.globalAlpha = 1;
      context.shadowBlur = 0;
      running = bursts.length > 0;
      if (running) sparkFrame = requestAnimationFrame(draw);
    };
    window.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 || event.pointerType === "touch") return;
        const turn = Math.random() * Math.PI;
        const particles = Array.from({ length: COUNT }, (_, i) => ({
          angle: (i / COUNT) * Math.PI * 2 + turn + (Math.random() - 0.5) * 0.35,
          reach: 0.55 + Math.random() * 0.6,
          radius: 1 + Math.random() ** 1.6 * 3,
        }));
        bursts.push({ x: event.clientX, y: event.clientY, particles, born: performance.now() });
        if (!running) {
          running = true;
          sparkFrame = requestAnimationFrame(draw);
        }
      },
      { signal },
    );

    return () => {
      controller.abort();
      cancelAnimationFrame(lightFrame);
      cancelAnimationFrame(sparkFrame);
    };
  }, [glowRef, canvasRef]);
}
