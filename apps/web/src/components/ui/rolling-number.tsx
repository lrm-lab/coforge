import { memo, useEffect, useRef, useState } from "react";
import { motion, useSpring, useTransform } from "motion/react";

import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";

// After Bencho's rolling counter (MIT, github.com/cabralorenzo/bencho).

/** 0-9 and a second 0: a carry rolls on from 9 into the closing 0 instead of back down the strip. */
const STRIP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((digit, cell) => (
  <span key={cell} className="block h-[1lh]">
    {digit}
  </span>
));

const SPRING = { visualDuration: 0.4, bounce: 0.15 } as const;

/** Where a column's strip sits for a running count of its place: that count taken round ten. */
const stripOffset = (count: number) => `${-((((count % 10) + 10) % 10) / STRIP.length) * 100}%`;

/**
 * A non-negative whole number whose digits roll like an odometer when it changes. A column counts
 * whole tens, hundreds and so on rather than showing a digit, so 9 → 10 moves the ones column
 * forward one step and never runs it back through 8…1, and a column that appears rolls in from 0.
 * Until the number first changes it is plain text, so a count that never moves costs a text
 * node; with reduced motion it stays plain text. Inherits font and color; the accessible text is
 * the plain number.
 */
export const RollingNumber = memo(function RollingNumber({ value }: { value: number }) {
  const whole = Math.max(0, Math.trunc(value));
  const reduced = usePrefersReducedMotion();
  // The number the last render showed: a column that mounts rolls from its count there.
  const previous = useRef(whole);
  const [changed, setChanged] = useState(false);
  if (!changed && whole !== previous.current) setChanged(true);
  useEffect(() => {
    previous.current = whole;
  });
  // Tabular like the columns, so the number keeps its width when it starts to roll.
  if (!changed || reduced) return <span className="tabular-nums">{whole}</span>;
  const digits = String(whole).length;
  return (
    <>
      <span className="sr-only">{whole}</span>
      <span aria-hidden="true" className="inline-flex align-top tabular-nums">
        {Array.from({ length: digits }, (_, index) => {
          const place = digits - 1 - index;
          return <Column key={place} place={place} value={whole} from={previous.current} />;
        })}
      </span>
    </>
  );
});

function Column({ place, value, from }: { place: number; value: number; from: number }) {
  const target = Math.floor(value / 10 ** place);
  const position = useSpring(Math.floor(from / 10 ** place), SPRING);
  const y = useTransform(position, stripOffset);
  useEffect(() => {
    // A far target is first approached in whole turns, which show the same digit, so a jump of
    // many steps (unread 2 → 40) rolls less than one turn instead of spinning into a blur.
    const gap = target - position.get();
    if (Math.abs(gap) >= 10) position.jump(position.get() + Math.trunc(gap / 10) * 10);
    position.set(target);
  }, [position, target]);
  return (
    <span className="block h-[1lh] overflow-hidden">
      <motion.span className="flex flex-col" style={{ y }}>
        {STRIP}
      </motion.span>
    </span>
  );
}
