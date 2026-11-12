import { Check, ChevronDown, Translate01 as Languages } from "@untitledui/icons";
import { Link } from "@tanstack/react-router";
import { Fragment, useRef } from "react";

import { Button as AriaButton } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { useLandingPointerEffects } from "./use-landing-pointer-effects";
import "./landing-page.css";

export const repositoryUrl = "https://github.com/lrm-lab/coforge";

// Lucide dropped brand marks, so the GitHub octicon is inlined here.
function GitHubMark({ className = "size-4 shrink-0" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

// Language endonyms stay untranslated, the way every locale switcher shows them;
// the accessible names come from the shared control catalog.
const locales = [
  {
    code: "en",
    label: "EN",
    href: "/en",
    name: () => m.controls_switch_to_english(),
  },
  {
    code: "zh-CN",
    label: "中文",
    href: "/zh-CN",
    name: () => m.controls_switch_to_chinese(),
  },
] as const;

function LocaleSwitch() {
  const active = getLocale();
  return (
    <Dropdown.Root>
      <AriaButton aria-label={m.landing_language()} className="home-lang outline-none">
        <Languages aria-hidden="true" />
        {locales.find((locale) => locale.code === active)?.label}
        <ChevronDown aria-hidden="true" className="home-chevron" />
      </AriaButton>
      <Dropdown.Popover placement="bottom end" className="w-40">
        <Dropdown.Menu
          aria-label={m.landing_language()}
          selectionMode="none"
          items={locales.map((locale) => ({ ...locale }))}
        >
          {(locale) => (
            <Dropdown.Item
              id={locale.code}
              href={locale.href}
              aria-label={locale.name()}
              data-current={locale.code === active ? "true" : undefined}
              label={locale.code === "en" ? "English" : "简体中文"}
              icon={locale.code === active ? Check : undefined}
            />
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

/** The three things CoForge's agents do, each with the designer's picture. */
const FEATURES = [
  {
    image: "/landing/feature-1.webp",
    title: () => m.landing_feature_memory_title(),
    body: () => m.landing_feature_memory_body(),
  },
  {
    image: "/landing/feature-2.webp",
    title: () => m.landing_feature_collaboration_title(),
    body: () => m.landing_feature_collaboration_body(),
  },
  {
    image: "/landing/feature-3.webp",
    title: () => m.landing_feature_evolving_title(),
    body: () => m.landing_feature_evolving_body(),
  },
] as const;

/** The pill's four-point star, in the design's lilac-to-brand gradient. */
function Sparkle() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <defs>
        <linearGradient
          id="home-sparkle"
          x1="1"
          y1="15"
          x2="13"
          y2="3"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#E1B2F7" />
          <stop offset="1" stopColor="#5D36DC" />
        </linearGradient>
      </defs>
      <path
        d="M8 0c.5 4.3 3.7 7.5 8 8-4.3.5-7.5 3.7-8 8-.5-4.3-3.7-7.5-8-8 4.3-.5 7.5-3.7 8-8Z"
        fill="url(#home-sparkle)"
      />
    </svg>
  );
}

/**
 * The public homepage, jing's v8 (#designers:#4): the logo and account links, the headline beside
 * the designer's picture of a person working with three agents, and a card of what the agents do.
 * One screen on a desktop, scaled to the window; a column on a phone. Light in every theme. The
 * layout, motion and pointer effects are `landing-page.css` and `use-landing-pointer-effects.ts`.
 */
export function LandingPage() {
  const glow = useRef<HTMLDivElement>(null);
  const sparks = useRef<HTMLCanvasElement>(null);
  useLandingPointerEffects(glow, sparks);

  return (
    <div className="home-page font-display">
      {/* The document itself is the page colour too, so overscroll never shows the app theme. */}
      <style>{`html,body{background:#eeebfe;color-scheme:light}`}</style>
      <div className="home-screen">
        <header className="home-nav">
          <div className="home-wrap home-nav-inner">
            <a className="home-logo" href="/" aria-label="CoForge">
              <img src="/login/homepage-logo.webp" alt="" />
            </a>
            <nav className="home-nav-actions">
              <a
                className="home-icon-link"
                href={repositoryUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={m.landing_action_repository()}
              >
                <GitHubMark className="" />
              </a>
              <LocaleSwitch />
              <Link to="/login" className="home-text-link">
                {m.landing_action_sign_in()}
              </Link>
              <Link to="/login" className="home-button">
                {m.landing_action_sign_up()}
              </Link>
            </nav>
          </div>
        </header>

        <main className="home-main">
          <section className="home-hero">
            {/* The designer's 5760 x 3600 canvas at a quarter, back to front: the background, the
                ring and cards, the purple agent, the green one, the person at the desk and the
                yellow one. Positions are percentages of that canvas. Each agent floats a third
                of a beat apart; green and purple blink. */}
            <div className="home-art-frame" aria-hidden="true">
              <div className="home-stage">
                <img className="home-stage-bg" src="/landing/page-bg.webp" alt="" />
                <div className="home-art-shift">
                  <img className="home-layer" src="/landing/mid.webp" alt="" />
                  <div
                    className="home-agent home-agent--purple"
                    style={{ left: "60.59%", top: "17.889%", width: "13.889%" }}
                  >
                    <img src="/landing/purple-open.webp" alt="" />
                    <img className="home-agent-closed" src="/landing/purple-closed.webp" alt="" />
                  </div>
                  <div
                    className="home-agent home-agent--green"
                    style={{ left: "47.483%", top: "33.833%", width: "11.528%" }}
                  >
                    <img src="/landing/green-open.webp" alt="" />
                    <img className="home-agent-closed" src="/landing/green-closed.webp" alt="" />
                  </div>
                  <img className="home-layer" src="/landing/fg.webp" alt="" />
                  <div
                    className="home-agent home-agent--yellow"
                    style={{ left: "84.444%", top: "36.444%", width: "12.5%" }}
                  >
                    <img src="/landing/yellow.webp" alt="" />
                  </div>
                </div>
              </div>
            </div>

            <div className="home-wrap home-hero-inner">
              <div className="home-hero-copy">
                <p className="home-eyebrow">
                  <Sparkle />
                  {m.landing_hero_eyebrow()}
                </p>
                <h1 className="home-title">
                  {m.landing_hero_title_line_1()}
                  <br />
                  {m.landing_hero_title_line_2()}
                  <span className="home-title-highlight">{m.landing_hero_title_highlight()}</span>
                </h1>
                <p className="home-body">{m.landing_hero_body()}</p>
              </div>
            </div>

            <div className="home-wrap">
              <ul className="home-features">
                {FEATURES.map((feature) => (
                  <li key={feature.image}>
                    <img src={feature.image} alt="" />
                    <div>
                      <h2>{feature.title()}</h2>
                      <p>
                        {/* The design breaks each line at its comma on a desktop; a column lets
                            it wrap. */}
                        {feature
                          .body()
                          .split("\n")
                          .map((line, index) => (
                            <Fragment key={index}>
                              {index > 0 && <br />}
                              {line}
                            </Fragment>
                          ))}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </main>
      </div>
      <canvas ref={sparks} className="home-sparks" aria-hidden="true" />
      <div ref={glow} className="home-glow" aria-hidden="true" />
    </div>
  );
}
