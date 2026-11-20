import { useEffect, useId, useRef } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  CodeBrowser,
  Folder,
  Globe01,
  MessageChatSquare,
  MessageSquare01,
  Stars01,
} from "@untitledui/icons";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { m } from "#src/paraglide/messages";
import {
  AREA_V2,
  CYCLE_MS,
  LINE_V2,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  STATIC_HERO_MS,
  applySceneFrame,
  createSceneRefs,
  type SceneRefs,
} from "./whats-new-artifacts-timeline";
import "./whats-new-artifacts-scene.css";

export function ArtifactsScene() {
  const reducedMotion = usePrefersReducedMotion();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const refs = useRef<SceneRefs>(createSceneRefs());
  const bind =
    <K extends keyof SceneRefs>(key: K) =>
    (node: SceneRefs[K]) => {
      refs.current[key] = node;
    };

  const uid = useId();
  const violetGradId = `${uid}-violet`;
  const cyanGradId = `${uid}-cyan`;
  const comment = m.whats_new_artifacts_demo_comment();

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    if (!root || !stage) return;
    const updateScale = () => {
      const scale = Math.min(root.clientWidth / STAGE_WIDTH, root.clientHeight / STAGE_HEIGHT);
      if (scale > 0) stage.style.setProperty("--wna-scale", scale.toFixed(4));
    };
    const observer = new ResizeObserver(updateScale);
    observer.observe(root);
    updateScale();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      applySceneFrame(refs.current, STATIC_HERO_MS, comment, false);
      return;
    }
    let raf = 0;
    let start = performance.now();
    const tick = (now: number) => {
      applySceneFrame(refs.current, (now - start) % CYCLE_MS, comment, true);
      raf = requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        start = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [comment, reducedMotion]);

  return (
    <div ref={rootRef} className="wna-root">
      <div ref={bind("aurora")} className="wna-aurora" />
      <div ref={stageRef} className="wna-stage">
        <div ref={bind("tabV1")} className="wna-version-tab wna-tab-v1 wna-smooth">
          <span>v1</span>
        </div>
        <div className="wna-version-tab wna-tab-v2 wna-smooth">
          <span ref={bind("tabV2Label")}>v2</span>
        </div>

        <div ref={bind("replyBubble")} className="wna-reply-bubble">
          <span className="wna-dots">
            <span ref={bind("dot1")} className="wna-dot" />
            <span ref={bind("dot2")} className="wna-dot" />
            <span ref={bind("dot3")} className="wna-dot" />
          </span>
          <Check className="wna-reply-check" strokeWidth={3.2} />
        </div>

        <div className="wna-mascot-wrap">
          <div ref={bind("mascotHalo")} className="wna-mascot-halo" />
          <img
            ref={bind("mascotImg")}
            src="/agent-avatars/mascot-purple-5.webp"
            alt=""
            decoding="async"
            className="wna-mascot-img"
          />
        </div>

        <div ref={bind("signalOrb")} className="wna-signal-orb" />

        <div className="wna-win">
          <div className="wna-header">
            <CoForgeMark className="h-[0.8125rem] w-auto [&_circle]:stroke-[#101319]" />
            <div className="wna-title">{m.whats_new_artifacts_demo_title()}</div>
            <div ref={bind("verPill")} className="wna-ver-pill wna-smooth">
              v2
            </div>
            <div className="wna-globe">
              <Globe01 className="size-[0.53125rem]" strokeWidth={2.2} />
            </div>
          </div>

          <div className="wna-body">
            <div className="wna-sidebar">
              <span className="wna-nav-icon">
                <MessageChatSquare className="size-[0.6875rem]" strokeWidth={1.9} />
              </span>
              <span className="wna-nav-icon">
                <Activity className="size-[0.6875rem]" strokeWidth={1.9} />
              </span>
              <span className="wna-nav-icon">
                <Stars01 className="size-[0.6875rem]" strokeWidth={1.9} />
              </span>
              <span className="wna-nav-icon">
                <Folder className="size-[0.6875rem]" strokeWidth={1.9} />
              </span>
              <span className="wna-nav-icon wna-nav-icon-active">
                <CodeBrowser className="size-[0.71875rem]" strokeWidth={2} />
              </span>
            </div>

            <div className="wna-canvas">
              <div className="wna-left-col">
                <div className="wna-chart-card">
                  <div className="wna-chart-head">
                    <div className="wna-chart-label">
                      <span className="wna-chart-dot" />
                      <span>{m.whats_new_artifacts_demo_growth()}</span>
                    </div>
                    <span className="wna-delta">+24%</span>
                  </div>
                  <svg viewBox="0 0 160 54" className="h-[3.25rem] w-full overflow-visible">
                    <defs>
                      <linearGradient id={violetGradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#7c5cfa" stopOpacity="0.45" />
                        <stop offset="100%" stopColor="#7c5cfa" stopOpacity="0.02" />
                      </linearGradient>
                      <linearGradient id={cyanGradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.32" />
                        <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.01" />
                      </linearGradient>
                    </defs>
                    <line x1="0" y1="16" x2="160" y2="16" stroke="#eef1f6" strokeWidth="0.8" />
                    <line x1="0" y1="34" x2="160" y2="34" stroke="#eef1f6" strokeWidth="0.8" />
                    <path
                      d="M 0 46 Q 28 38 56 41 T 112 24 T 160 30 L 160 52 L 0 52 Z"
                      fill={`url(#${cyanGradId})`}
                    />
                    <path
                      d="M 0 46 Q 28 38 56 41 T 112 24 T 160 30"
                      fill="none"
                      stroke="#22d3ee"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                    <path d={AREA_V2} fill={`url(#${violetGradId})`} />
                    <path
                      d={LINE_V2}
                      fill="none"
                      stroke="#5d36dc"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                    <circle
                      cx="160"
                      cy="16"
                      r="2.6"
                      fill="#5d36dc"
                      stroke="#ffffff"
                      strokeWidth="1.2"
                    />
                  </svg>
                </div>

                <div className="wna-kpi-grid">
                  <div className="wna-kpi-card">
                    <span className="wna-kpi-num">316</span>
                    <div className="flex flex-col gap-[0.15625rem]">
                      <span className="h-[0.1875rem] w-[85%] rounded-full bg-[#8f6ff2]" />
                      <span className="h-[0.1875rem] w-[55%] rounded-full bg-[#f472b6]" />
                    </div>
                  </div>
                  <div className="wna-kpi-card">
                    <span className="wna-kpi-num">98%</span>
                    <div className="flex flex-col gap-[0.15625rem]">
                      <span className="h-[0.1875rem] w-[92%] rounded-full bg-[#10b981]" />
                      <span className="h-[0.1875rem] w-[64%] rounded-full bg-[#38bdf8]" />
                    </div>
                  </div>

                  <div ref={bind("funnel")} className="wna-funnel wna-smooth">
                    <div className="wna-funnel-shimmer-clip">
                      <div ref={bind("funnelShimmer")} className="wna-shimmer" />
                    </div>
                    <div className="wna-funnel-head">
                      <span ref={bind("funnelLabel")} className="wna-funnel-label wna-smooth">
                        {m.whats_new_artifacts_demo_funnel()}
                      </span>
                      <span ref={bind("funnelCheck")} className="wna-funnel-check">
                        <Check className="size-[0.375rem]" strokeWidth={3.5} />
                      </span>
                    </div>
                    <div className="wna-bars">
                      <span
                        ref={bind("bar1")}
                        className="wna-bar"
                        style={{ height: "55%", background: "#fb923c" }}
                      />
                      <span
                        ref={bind("bar2")}
                        className="wna-bar"
                        style={{ height: "78%", background: "#f97316" }}
                      />
                      <span
                        ref={bind("bar3")}
                        className="wna-bar"
                        style={{ height: "48%", background: "#fdba74" }}
                      />
                      <span
                        ref={bind("bar4")}
                        className="wna-bar"
                        style={{ height: "90%", background: "#ea580c" }}
                      />
                    </div>
                    <div ref={bind("orangeBox")} className="wna-orange-box">
                      <span className="wna-handle -top-[2.5px] -left-[2.5px]" />
                      <span className="wna-handle -top-[2.5px] -right-[2.5px]" />
                      <span className="wna-handle -bottom-[2.5px] -left-[2.5px]" />
                      <span className="wna-handle -right-[2.5px] -bottom-[2.5px]" />
                    </div>
                    <div ref={bind("violetBox")} className="wna-violet-box" />
                  </div>
                </div>
              </div>

              <div className="wna-doc-col">
                <div className="flex items-center gap-[0.25rem]">
                  <span className="size-[0.375rem] rounded-full bg-[#a993ff]" />
                  <span className="h-[0.25rem] w-[2.625rem] rounded-full bg-[#cbd5e1]" />
                </div>
                <div className="flex flex-col gap-[0.21875rem] rounded-[0.3125rem] bg-[#f5f3ff] p-[0.3125rem]">
                  <span className="h-[0.21875rem] w-[88%] rounded-full bg-[#c4b5fd]" />
                  <span className="h-[0.21875rem] w-[65%] rounded-full bg-[#ddd6fe]" />
                </div>
                <div className="mt-[0.125rem] flex flex-col gap-[0.25rem]">
                  <span className="h-[0.21875rem] w-[92%] rounded-full bg-[#e2e8f0]" />
                  <span className="h-[0.21875rem] w-[78%] rounded-full bg-[#e2e8f0]" />
                  <span className="h-[0.21875rem] w-[84%] rounded-full bg-[#e2e8f0]" />
                  <span className="h-[0.21875rem] w-[58%] rounded-full bg-[#e2e8f0]" />
                </div>
                <div className="mt-auto flex gap-[0.1875rem]">
                  <span className="h-[0.6875rem] flex-1 rounded-[0.25rem] bg-[#f1f5f9]" />
                  <span className="h-[0.6875rem] w-[1.125rem] rounded-[0.25rem] bg-[#efe8ff]" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div ref={bind("reviewCard")} className="wna-review-card">
          <div className="flex items-start gap-[0.4375rem]">
            <img
              src="/avatars/person-1-2.webp"
              alt=""
              decoding="async"
              className="wna-review-avatar"
            />
            <div className="min-w-0 flex-1">
              <div className="wna-review-chip">&lt;funnel&gt;</div>
              <div ref={bind("reviewText")} className="wna-review-text" />
            </div>
            <div ref={bind("sendPill")} className="wna-send-pill">
              <ArrowRight className="size-[0.625rem]" strokeWidth={2.4} />
            </div>
          </div>
        </div>

        <div ref={bind("fab")} className="wna-fab">
          <MessageSquare01 className="size-[0.6875rem]" strokeWidth={2} />
          <span ref={bind("fabBadge")} className="wna-fab-badge">
            1
          </span>
        </div>

        <div
          ref={bind("cursor")}
          className="wna-cursor"
          style={{ transform: "translate(374px, 210px)", opacity: 0 }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            className="drop-shadow-[0_2px_4px_rgba(0,0,0,0.35)]"
          >
            <path
              d="M5.5 3.2L18.8 12.1L12.3 13.4L9.2 19.6L5.5 3.2Z"
              fill="#101319"
              stroke="#ffffff"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div
          ref={bind("agentCursor")}
          className="wna-agent-cursor"
          style={{ transform: "translate(114px, 168px)", opacity: 0 }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            className="drop-shadow-[0_2px_6px_rgba(93,54,220,0.45)]"
          >
            <path
              d="M5.5 3.2L18.8 12.1L12.3 13.4L9.2 19.6L5.5 3.2Z"
              fill="#5d36dc"
              stroke="#ffffff"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
          <span className="wna-agent-tag">Agent</span>
        </div>
      </div>
    </div>
  );
}
