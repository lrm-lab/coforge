<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useData, useRoute, withBase } from "vitepress";

type NavItem = { text: string; link: string };

const FOLD_THRESHOLD = 8;
const OPEN_THRESHOLD = 8;
const TOP_OPEN = 48;
const HOLD_MS = 320;
const MOBILE_QUERY = "(max-width: 959px)";

const { theme } = useData();
const route = useRoute();

function normalizePath(path: string): string {
  const clean = path.replace(/\.html$/, "").replace(/\/index$/, "/");
  return clean === "" ? "/" : clean.endsWith("/") && clean !== "/" ? clean.slice(0, -1) : clean;
}

const flatItems = computed<NavItem[]>(() => {
  const raw = theme.value.sidebar;
  if (!Array.isArray(raw)) return [];
  const list: NavItem[] = [];
  for (const entry of raw) {
    if (entry && typeof entry.link === "string" && typeof entry.text === "string") {
      list.push({ text: entry.text, link: entry.link });
    }
    if (entry && Array.isArray(entry.items)) {
      for (const child of entry.items) {
        if (child && typeof child.link === "string" && typeof child.text === "string") {
          list.push({ text: child.text, link: child.link });
        }
      }
    }
  }
  return list;
});

const pair = computed<{ prev: NavItem; next: NavItem } | null>(() => {
  const items = flatItems.value;
  if (items.length < 2) return null;
  const current = normalizePath(route.path);
  const index = items.findIndex((item) => normalizePath(withBase(item.link)) === current);
  if (index === -1) return null;
  const prev = items[(index - 1 + items.length) % items.length]!;
  const next = items[(index + 1) % items.length]!;
  return { prev, next };
});

const prevPrefix = computed(() => theme.value.docFooter?.prev || "Previous");
const nextPrefix = computed(() => theme.value.docFooter?.next || "Next");

const folded = ref(false);
let lastScrollY: number | null = null;
let downAccum = 0;
let upAccum = 0;
let lastTransitionAt = -Infinity;
let pendingFolded: boolean | null = null;
let focused = false;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let listeningScroll = false;
let mediaQuery: MediaQueryList | null = null;

function applyTarget(target: boolean, now: number) {
  if (focused && target) {
    folded.value = false;
    pendingFolded = null;
    return;
  }
  if (now - lastTransitionAt < HOLD_MS) {
    pendingFolded = target === folded.value ? null : target;
    clearTimeout(holdTimer);
    if (pendingFolded !== null) {
      const wait = Math.max(0, HOLD_MS - (now - lastTransitionAt));
      holdTimer = setTimeout(() => {
        if (pendingFolded !== null) {
          const next = pendingFolded;
          pendingFolded = null;
          applyTarget(next, performance.now());
        }
      }, wait + 4);
    }
    return;
  }
  if (target === folded.value) {
    pendingFolded = null;
    return;
  }
  folded.value = target;
  lastTransitionAt = now;
  pendingFolded = null;
  downAccum = 0;
  upAccum = 0;
}

function onScroll() {
  const scrollY = window.scrollY;
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  if (maxScroll <= 0 || scrollY < 0 || scrollY > maxScroll + 1) return;
  const now = performance.now();
  if (lastScrollY === null) {
    lastScrollY = scrollY;
    if (scrollY <= TOP_OPEN) applyTarget(false, now);
    return;
  }
  const delta = scrollY - lastScrollY;
  lastScrollY = scrollY;
  if (Math.abs(delta) > window.innerHeight) {
    downAccum = 0;
    upAccum = 0;
    return;
  }
  if (scrollY <= TOP_OPEN) {
    downAccum = 0;
    upAccum = 0;
    applyTarget(false, now);
    return;
  }
  if (delta > 0) {
    downAccum += delta;
    upAccum = 0;
    if (downAccum >= FOLD_THRESHOLD) applyTarget(true, now);
  } else if (delta < 0) {
    upAccum -= delta;
    downAccum = 0;
    if (upAccum >= OPEN_THRESHOLD) applyTarget(false, now);
  }
}

function openNow() {
  clearTimeout(holdTimer);
  pendingFolded = null;
  downAccum = 0;
  upAccum = 0;
  if (folded.value) {
    folded.value = false;
    lastTransitionAt = performance.now();
  }
}

function syncScrollListener() {
  const shouldListen = Boolean(pair.value) && Boolean(mediaQuery?.matches);
  if (shouldListen && !listeningScroll) {
    window.addEventListener("scroll", onScroll, { passive: true });
    listeningScroll = true;
  } else if (!shouldListen && listeningScroll) {
    window.removeEventListener("scroll", onScroll);
    listeningScroll = false;
    lastScrollY = null;
    openNow();
  }
}

function onLinkClick(event: MouseEvent) {
  if (!folded.value) return;
  event.preventDefault();
  openNow();
}

function onFocusIn(event: FocusEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches(":focus-visible")) return;
  focused = true;
  openNow();
}

function onFocusOut(event: FocusEvent) {
  const nav = event.currentTarget as HTMLElement | null;
  if (nav && nav.contains(event.relatedTarget as Node | null)) return;
  focused = false;
}

const noopTouch = () => {};

watch(
  () => route.path,
  () => {
    lastScrollY = null;
    openNow();
    syncScrollListener();
  },
);

onMounted(() => {
  // Safari on iOS applies :active styles to touch taps only when the document listens for touchstart.
  document.addEventListener("touchstart", noopTouch, { passive: true });
  mediaQuery = window.matchMedia(MOBILE_QUERY);
  mediaQuery.addEventListener("change", syncScrollListener);
  syncScrollListener();
});

onBeforeUnmount(() => {
  document.removeEventListener("touchstart", noopTouch);
  mediaQuery?.removeEventListener("change", syncScrollListener);
  if (listeningScroll) {
    window.removeEventListener("scroll", onScroll);
    listeningScroll = false;
  }
  clearTimeout(holdTimer);
});
</script>

<template>
  <nav
    v-if="pair"
    aria-label="Page navigation"
    class="docs-foot-bar"
    :data-folded="folded ? 'true' : 'false'"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <div class="docs-foot-bar__shell">
      <a
        :href="withBase(pair.prev.link)"
        :aria-label="`${prevPrefix}: ${pair.prev.text}`"
        class="docs-foot-bar__link docs-foot-bar__link--prev"
        @click="onLinkClick"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" class="docs-foot-bar__arrow">
          <path
            d="M10 3.5 5.5 8 10 12.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span class="docs-foot-bar__title">{{ pair.prev.text }}</span>
      </a>
      <a
        :href="withBase(pair.next.link)"
        :aria-label="`${nextPrefix}: ${pair.next.text}`"
        class="docs-foot-bar__link docs-foot-bar__link--next"
        @click="onLinkClick"
      >
        <span class="docs-foot-bar__title">{{ pair.next.text }}</span>
        <svg aria-hidden="true" viewBox="0 0 16 16" class="docs-foot-bar__arrow">
          <path
            d="M6 3.5 10.5 8 6 12.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </a>
    </div>
  </nav>
</template>
