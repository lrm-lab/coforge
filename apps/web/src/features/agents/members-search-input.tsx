import { useEffect, useRef, useState } from "react";
import { SearchLg as Search } from "@untitledui/icons";

import { Input } from "#src/components/base/input/input";

const SEARCH_DEBOUNCE_MS = 250;

export function MembersSearchInput({
  label,
  resetSignal,
  onQueryChange,
  className = "min-w-[12rem] flex-1",
}: {
  label: string;
  resetSignal: number;
  onQueryChange: (query: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState("");
  const lastResetRef = useRef(resetSignal);
  const lastEmittedRef = useRef("");

  useEffect(() => {
    if (lastResetRef.current === resetSignal) return;
    lastResetRef.current = resetSignal;
    lastEmittedRef.current = "";
    setValue("");
  }, [resetSignal]);

  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed === lastEmittedRef.current) return;
    const timer = setTimeout(() => {
      lastEmittedRef.current = trimmed;
      onQueryChange(trimmed);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, onQueryChange]);

  return (
    <Input
      type="search"
      size="sm"
      icon={Search}
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={setValue}
      className={className}
    />
  );
}
