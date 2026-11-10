import { useEffect, useRef, useState } from "react";

import { m } from "#src/paraglide/messages";
import { useAttachLoginArt, type LoginWelcome } from "./login-art-state";
import "./login-art.css";

/** The greeting's sway, from the agent's foot: twice to each side, settling. */
const SWAY: Keyframe[] = [
  { transform: "rotate(0deg)" },
  { transform: "rotate(-8deg)", offset: 0.22 },
  { transform: "rotate(7deg)", offset: 0.5 },
  { transform: "rotate(-3deg)", offset: 0.76 },
  { transform: "rotate(0deg)" },
];
const SWAY_MS = 900;
/** The bubble stays up this long after the sway, so it is read before the page goes. */
const HOLD_MS = 200;
/** However the browser treats the animation, sign-in never waits on it longer than this. */
const WELCOME_MAX_MS = 1600;

/** Leaning back, as if not looking, while a password is typed. */
const LEAN: Keyframe[] = [
  { transform: "rotate(0deg) translateX(0)" },
  { transform: "rotate(-4deg) translateX(-2%)" },
];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The brand panel's picture, in the designer's own layers (`public/login/`): the door frame, the
 * white door standing ajar in it (it swings further in on hover), the agent in front and its shadow
 * on the ground. The motion is `login-art.css`.
 *
 * The agent answers the forms beside it (jing, 11-10; `login-art-state.tsx`): while a password is
 * typed it smiles with its eyes shut and leans away; once signed in it sways hello with a bubble
 * that says "welcome back", or "welcome aboard" to an account just made. Her smiling face is its
 * own layer, crossfaded over the open-eyed one.
 */
export function LoginArt() {
  const attach = useAttachLoginArt();
  const root = useRef<HTMLDivElement>(null);
  const agent = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const [greeting, setGreeting] = useState<LoginWelcome | null>(null);

  useEffect(() => {
    let lean: Animation | null = null;
    attach({
      lookAway(next) {
        setAway(next);
        const el = agent.current;
        if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        if (next && !lean) {
          lean = el.animate(LEAN, {
            duration: 220,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            fill: "forwards",
          });
        } else if (!next && lean) {
          const back = lean;
          lean = null;
          back.reverse();
          back.finished.then(() => back.cancel()).catch(() => {});
        }
      },
      async welcome(kind) {
        const el = agent.current;
        // Below `xl` the panel is not shown; there is no one to watch the greeting.
        if (!el || !root.current?.offsetParent) return;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        lean?.cancel();
        lean = null;
        setGreeting(kind);
        const sway = el.animate(SWAY, { duration: SWAY_MS, easing: "ease-in-out" });
        await Promise.race([
          sway.finished.then(() => wait(HOLD_MS)).catch(() => {}),
          wait(WELCOME_MAX_MS),
        ]);
      },
    });
    return () => attach(null);
  }, [attach]);

  const smiling = away || greeting !== null;
  return (
    <div ref={root} className="login-art" aria-hidden="true">
      <img src="/login/frame.webp" alt="" className="login-art__frame" />
      <img src="/login/door.webp" alt="" className="login-art__door" />
      <img src="/login/shadow.webp" alt="" className="login-art__shadow" />
      <div ref={agent} className="login-art__agent">
        <div className="login-art__float">
          <img src="/login/agent.webp" alt="" className="login-art__face" />
          <img
            src="/login/agent-smile.webp"
            alt=""
            className="login-art__face login-art__face--smile"
            data-shown={smiling || undefined}
          />
        </div>
      </div>
      {greeting ? (
        <div className="login-art__bubble">
          {greeting === "joined" ? m.login_welcome_joined() : m.login_welcome_back()}
        </div>
      ) : null}
    </div>
  );
}
