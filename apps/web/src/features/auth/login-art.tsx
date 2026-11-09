import "./login-art.css";

/**
 * The brand panel's picture, in the designer's own layers (`public/login/`): the door frame, the
 * white door standing ajar in it (it swings further in on hover), the agent in front and its shadow
 * on the ground. The motion is `login-art.css`.
 */
export function LoginArt() {
  return (
    <div className="login-art" aria-hidden="true">
      <img src="/login/frame.webp" alt="" className="login-art__frame" />
      <img src="/login/door.webp" alt="" className="login-art__door" />
      <img src="/login/shadow.webp" alt="" className="login-art__shadow" />
      <img src="/login/agent.webp" alt="" className="login-art__agent" />
    </div>
  );
}
