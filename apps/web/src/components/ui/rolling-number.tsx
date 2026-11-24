import { memo, useEffect, useRef, useState } from "react";
import { useSpring, useTransform } from "motion/react";
import * as motion from "motion/react-m";

import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";

const STRIP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((digit, cell) => (
  <span key={cell} className="block h-[1lh]">
    {digit}
  </span>
));

const SPRING = { visualDuration: 0.3, bounce: 0.15 } as const;

const stripOffset = (count: number) => `${-((((count % 10) + 10) % 10) / STRIP.length) * 100}%`;

export const RollingNumber = memo(function RollingNumber({ value }: { value: number }) {
  const whole = Math.max(0, Math.trunc(value));
  const reduced = usePrefersReducedMotion();
  const previous = useRef(whole);
  const [changed, setChanged] = useState(false);
  if (!changed && whole !== previous.current) setChanged(true);
  useEffect(() => {
    previous.current = whole;
  });
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
