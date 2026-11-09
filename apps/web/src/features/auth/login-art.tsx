import "./login-art.css";

/**
 * The brand panel's picture (layers in `public/login/`, cut from the designer's mock): an arch
 * whose inner door panel is a layer of its own (it swings on hover), with the agent in front of it and its shadow on the ground. The motion is `login-art.css`.
 */
export function LoginArt() {
  return (
    <div className="login-art" aria-hidden="true">
      <img src="/login/arch.webp" alt="" className="login-art__arch" />
      <img src="/login/door.webp" alt="" className="login-art__door" />
      <img src="/login/shadow.webp" alt="" className="login-art__shadow" />
      <img src="/login/agent.webp" alt="" className="login-art__agent" />
    </div>
  );
}
