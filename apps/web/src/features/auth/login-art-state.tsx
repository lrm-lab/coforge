import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";

/** How the sign-in finished: an account that had signed in before, or one just made. */
export type LoginWelcome = "back" | "joined";

/**
 * What the sign-in forms can ask of the brand panel's agent (jing, 11-10): to look away while a
 * password is typed, and to greet the person once they are in. `welcome` settles when the greeting
 * has played, at once when the agent is not on screen or the person asked for less motion, so a
 * form can wait for it before leaving the page; the provider bounds it (`boundedWelcome`).
 */
export type LoginArtControls = {
  lookAway(away: boolean): void;
  welcome(kind: LoginWelcome): Promise<void>;
};

const STILL: LoginArtControls = { lookAway: () => {}, welcome: async () => {} };

/** The longest a sign-in waits on the greeting before it leaves the page (Raft, 11-10). */
export const WELCOME_LIMIT_MS = 1_500;

/**
 * A greeting the sign-in can always get past: settled when it has played, or after
 * `WELCOME_LIMIT_MS` whatever it does (an animation that never finishes, an image not loaded), at
 * once in a background tab where no one watches it, and never rejected: a greeting that fails does
 * not undo a sign-in that worked.
 */
export function boundedWelcome(
  welcome: () => Promise<void>,
  { limitMs = WELCOME_LIMIT_MS, hidden = () => document.hidden } = {},
): Promise<void> {
  if (hidden()) return Promise.resolve();
  let played: Promise<void>;
  try {
    played = welcome().catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
  return Promise.race([played, new Promise<void>((resolve) => setTimeout(resolve, limitMs))]);
}

const Context = createContext<{
  controls: LoginArtControls;
  attach: (art: LoginArtControls | null) => void;
}>({ controls: STILL, attach: () => {} });

/** Joins the forms to the agent they sit beside. Without one (the reset page) the forms ask
 * nothing of anyone. */
export function LoginArtProvider({ children }: { children: ReactNode }) {
  const art = useRef<LoginArtControls | null>(null);
  const value = useMemo(
    () => ({
      controls: {
        lookAway: (away: boolean) => (art.current ?? STILL).lookAway(away),
        welcome: (kind: LoginWelcome) => boundedWelcome(() => (art.current ?? STILL).welcome(kind)),
      },
      attach: (next: LoginArtControls | null) => {
        art.current = next;
      },
    }),
    [],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** For a sign-in form: the agent beside it. */
export function useLoginArt(): LoginArtControls {
  return useContext(Context).controls;
}

/** For the agent: hands its controls to the forms. */
export function useAttachLoginArt() {
  return useContext(Context).attach;
}
