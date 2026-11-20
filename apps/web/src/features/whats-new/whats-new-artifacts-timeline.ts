export const STAGE_WIDTH = 480;
export const STAGE_HEIGHT = 270;
export const CYCLE_MS = 14800;
export const STATIC_HERO_MS = 13200;

export const AREA_V2 = "M 0 44 Q 26 24 52 31 T 104 20 T 160 16 L 160 52 L 0 52 Z";
export const LINE_V2 = "M 0 44 Q 26 24 52 31 T 104 20 T 160 16";

export type SceneRefs = {
  aurora: HTMLDivElement | null;
  tabV1: HTMLDivElement | null;
  tabV2Label: HTMLSpanElement | null;
  mascotHalo: HTMLDivElement | null;
  mascotImg: HTMLImageElement | null;
  replyBubble: HTMLDivElement | null;
  dot1: HTMLSpanElement | null;
  dot2: HTMLSpanElement | null;
  dot3: HTMLSpanElement | null;
  signalOrb: HTMLDivElement | null;
  funnelShimmer: HTMLDivElement | null;
  verPill: HTMLDivElement | null;
  funnel: HTMLDivElement | null;
  funnelLabel: HTMLSpanElement | null;
  funnelCheck: HTMLSpanElement | null;
  bar1: HTMLSpanElement | null;
  bar2: HTMLSpanElement | null;
  bar3: HTMLSpanElement | null;
  bar4: HTMLSpanElement | null;
  orangeBox: HTMLDivElement | null;
  violetBox: HTMLDivElement | null;
  reviewCard: HTMLDivElement | null;
  reviewText: HTMLDivElement | null;
  sendPill: HTMLDivElement | null;
  fab: HTMLDivElement | null;
  fabBadge: HTMLSpanElement | null;
  pointer: HTMLDivElement | null;
  agentCursor: HTMLDivElement | null;
};

export function createSceneRefs(): SceneRefs {
  return {
    aurora: null,
    tabV1: null,
    tabV2Label: null,
    mascotHalo: null,
    mascotImg: null,
    replyBubble: null,
    dot1: null,
    dot2: null,
    dot3: null,
    signalOrb: null,
    funnelShimmer: null,
    verPill: null,
    funnel: null,
    funnelLabel: null,
    funnelCheck: null,
    bar1: null,
    bar2: null,
    bar3: null,
    bar4: null,
    orangeBox: null,
    violetBox: null,
    reviewCard: null,
    reviewText: null,
    sendPill: null,
    fab: null,
    fabBadge: null,
    pointer: null,
    agentCursor: null,
  };
}

function setText(el: HTMLElement | null, value: string) {
  if (el && el.textContent !== value) el.textContent = value;
}

export function applySceneFrame(refs: SceneRefs, t: number, comment: string, ambient: boolean) {
  if (refs.aurora) {
    const wave = ambient ? Math.sin((t / CYCLE_MS) * Math.PI * 2) : 0;
    refs.aurora.style.transform = `translate(${(-wave * 8).toFixed(2)}px, ${(wave * 6).toFixed(2)}px) scale(${(1 + (wave + 1) * 0.025).toFixed(4)})`;
  }

  if (refs.pointer) {
    if (t < 1800) {
      refs.pointer.style.opacity = "0";
      refs.pointer.style.transform = "translate(374px, 210px)";
    } else if (t < 5200) {
      refs.pointer.style.opacity = "1";
      refs.pointer.style.transform = "translate(278px, 198px)";
    } else if (t < 6150) {
      refs.pointer.style.opacity = "1";
      refs.pointer.style.transform = "translate(442px, 206px)";
    } else {
      refs.pointer.style.opacity = "0";
      refs.pointer.style.transform = "translate(454px, 218px)";
    }
  }

  const selected = t >= 2600 && t < 6220;
  if (refs.orangeBox) refs.orangeBox.dataset.active = String(selected);
  if (refs.fab) refs.fab.dataset.picking = String(selected);
  if (refs.fabBadge) {
    refs.fabBadge.style.opacity = selected ? "1" : "0";
    refs.fabBadge.style.transform = selected ? "scale(1)" : "scale(0.3)";
  }

  const cardOpen = t >= 3050 && t < 6150;
  if (refs.reviewCard) refs.reviewCard.dataset.open = String(cardOpen);
  if (t >= 3350 && t < 6150) {
    const pct = Math.min(1, (t - 3350) / 1500);
    setText(refs.reviewText, comment.slice(0, Math.max(1, Math.round(pct * comment.length))));
  } else {
    setText(refs.reviewText, "");
  }

  const pressing = t >= 5750 && t < 6150;
  if (refs.sendPill) {
    refs.sendPill.style.transform = pressing ? "scale(0.84)" : "scale(1)";
    refs.sendPill.style.background = pressing ? "#5d36dc" : "#171b23";
  }

  if (refs.signalOrb) {
    if (t >= 6100 && t < 6850) {
      const u = (t - 6100) / 750;
      const ease = 1 - (1 - u) ** 3;
      const x = 440 + (62 - 440) * ease;
      const y = 205 + (146 - 205) * ease - Math.sin(u * Math.PI) * 56;
      const scale = 1 - Math.abs(u - 0.5) * 0.45;
      refs.signalOrb.style.opacity = String(u < 0.85 ? 1 : (1 - u) / 0.15);
      refs.signalOrb.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
    } else {
      refs.signalOrb.style.opacity = "0";
    }
  }

  const isWorking = t >= 6650 && t < 10000;
  const isV3 = t >= 10000;
  const bubbleOpen = t >= 6650 && t < 12800;

  if (refs.mascotHalo) {
    if (isWorking && ambient) {
      const pulse = 0.5 + 0.5 * Math.sin(((t - 6650) / 1100) * Math.PI * 2);
      refs.mascotHalo.style.opacity = (0.65 + 0.35 * pulse).toFixed(3);
      refs.mascotHalo.style.transform = `scale(${(0.96 + 0.12 * pulse).toFixed(3)})`;
    } else {
      refs.mascotHalo.style.opacity = "0";
      refs.mascotHalo.style.transform = "scale(0.86)";
    }
  }

  if (refs.mascotImg) {
    const gentleY = ambient ? Math.sin(t / 1300) * 1.6 : 0;
    const leanX = isWorking ? 2.5 : 0;
    const scale = isWorking ? 1.03 : 1;
    refs.mascotImg.style.transform = `translate(${leanX}px, ${gentleY.toFixed(2)}px) scale(${scale})`;
  }

  if (refs.replyBubble) {
    refs.replyBubble.dataset.open = String(bubbleOpen);
    refs.replyBubble.dataset.done = String(isV3);
  }

  if (isWorking && ambient) {
    const dots = [refs.dot1, refs.dot2, refs.dot3];
    for (let i = 0; i < dots.length; i += 1) {
      const dot = dots[i];
      if (!dot) continue;
      const phase = ((t - 6650 - i * 210) / 1050) * Math.PI * 2;
      dot.style.opacity = (0.32 + 0.68 * (0.5 + 0.5 * Math.sin(phase))).toFixed(3);
    }
  }

  if (refs.violetBox) refs.violetBox.dataset.active = String(isWorking);

  if (refs.agentCursor) {
    if (!isWorking) {
      refs.agentCursor.style.opacity = "0";
      refs.agentCursor.style.transform = "translate(114px, 168px)";
    } else if (t < 7550) {
      refs.agentCursor.style.opacity = "1";
      refs.agentCursor.style.transform = "translate(252px, 202px)";
    } else if (t < 8350) {
      refs.agentCursor.style.opacity = "1";
      refs.agentCursor.style.transform = "translate(268px, 198px)";
    } else if (t < 9150) {
      refs.agentCursor.style.opacity = "1";
      refs.agentCursor.style.transform = "translate(284px, 199px)";
    } else {
      refs.agentCursor.style.opacity = "1";
      refs.agentCursor.style.transform = "translate(298px, 194px)";
    }
  }

  if (refs.verPill) {
    if (isV3) {
      setText(refs.verPill, "v3");
      refs.verPill.style.background = "#5d36dc";
      refs.verPill.style.color = "#ffffff";
      refs.verPill.style.borderColor = "#5d36dc";
      refs.verPill.style.transform = t >= 10000 && t < 11000 ? "scale(1.06)" : "scale(1)";
    } else if (isWorking) {
      setText(refs.verPill, "v2 → v3");
      refs.verPill.style.background = "#f5f3ff";
      refs.verPill.style.color = "#5d36dc";
      refs.verPill.style.borderColor = "#c4b5fd";
      refs.verPill.style.transform = "scale(1.03)";
    } else {
      setText(refs.verPill, "v2");
      refs.verPill.style.background = "#f4f6fa";
      refs.verPill.style.color = "#475467";
      refs.verPill.style.borderColor = "#e0e5f1";
      refs.verPill.style.transform = "scale(1)";
    }
  }

  setText(refs.tabV2Label, isV3 ? "v2" : "v1");
  if (refs.tabV1) {
    refs.tabV1.style.opacity = isV3 ? "1" : "0";
    refs.tabV1.style.transform = isV3 ? "translateY(0px)" : "translateY(8px)";
  }

  const b1 = t >= 7150;
  const b2 = t >= 7900;
  const b3 = t >= 8650;
  const b4 = t >= 9250;
  if (refs.bar1) {
    refs.bar1.style.background = b1 ? "#e0d7fe" : "#d0d5dd";
    refs.bar1.style.height = "52%";
  }
  if (refs.bar2) {
    refs.bar2.style.background = b2 ? "#e0d7fe" : "#cbd5e1";
    refs.bar2.style.height = "68%";
  }
  if (refs.bar3) {
    refs.bar3.style.background = b3 ? "#e0d7fe" : "#cbd5e1";
    refs.bar3.style.height = "58%";
  }
  if (refs.bar4) {
    refs.bar4.style.background = b4 ? "#5d36dc" : "#98a2b3";
    refs.bar4.style.height = b4 ? "100%" : "94%";
    refs.bar4.style.boxShadow = b4 ? "0 0 8px rgba(93, 54, 220, 0.55)" : "none";
  }

  if (refs.funnel) {
    refs.funnel.style.background = b4 ? "#f4f0ff" : "#ffffff";
    refs.funnel.style.borderColor = b4 ? "#7c5cfa" : "#e6eaf2";
    refs.funnel.style.boxShadow = isV3
      ? "0 4px 14px -2px rgba(93, 54, 220, 0.28), 0 0 0 1.5px rgba(124, 92, 250, 0.32)"
      : "none";
    refs.funnel.style.transform = isV3 ? "translateY(-1px)" : "translateY(0px)";
  }
  if (refs.funnelLabel) refs.funnelLabel.style.color = b4 ? "#5d36dc" : "#667085";
  if (refs.funnelCheck) {
    refs.funnelCheck.style.opacity = isV3 ? "1" : "0";
    refs.funnelCheck.style.transform = isV3 ? "scale(1)" : "scale(0.4)";
  }

  if (refs.funnelShimmer) {
    if (ambient && t >= 9800 && t < 11300) {
      const p = (t - 9800) / 1500;
      const eased = 0.5 - 0.5 * Math.cos(p * Math.PI);
      refs.funnelShimmer.style.transform = `translateX(${(-120 + eased * 250).toFixed(1)}%)`;
    } else {
      refs.funnelShimmer.style.transform = "translateX(-120%)";
    }
  }
}
