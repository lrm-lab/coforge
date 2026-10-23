import { useEffect, useState } from "react";

export type Section = { id: string; title: string };

/** The section the form is scrolled to: the first one showing in the top of the scroll area, or
 * the last once the area is scrolled to its end (a short last section never reaches the top). */
export function useActiveSection(
  scroller: React.RefObject<HTMLDivElement | null>,
  sections: Section[],
): [string, (id: string) => void] {
  const ids = sections.map((section) => section.id).join(" ");
  const [active, setActive] = useState(sections[0]!.id);
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const order = ids.split(" ");
    const atEnd = () => root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
    const choose = () => {
      const first = order.find((id) => visible.has(id));
      if (atEnd() && root.scrollTop > 0) setActive(order[order.length - 1]!);
      else if (first) setActive(first);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        choose();
      },
      // A section counts once it reaches the top two-fifths of the scroll area.
      { root, rootMargin: "0px 0px -60% 0px" },
    );
    for (const id of order) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    root.addEventListener("scroll", choose, { passive: true });
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", choose);
    };
  }, [scroller, ids]);
  return [active, setActive];
}
