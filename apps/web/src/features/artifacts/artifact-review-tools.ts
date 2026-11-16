import { createContext, useContext, useEffect } from "react";

export type FramePicker = { picking: boolean; disabled: boolean; toggle: () => void };

export const ReviewToolsContext = createContext<(picker: FramePicker | null) => void>(() => {});

export function useRegisterFramePicker(picker: FramePicker | null) {
  const register = useContext(ReviewToolsContext);
  const { picking, disabled, toggle } = picker ?? { picking: false, disabled: false, toggle: null };
  const present = picker !== null;
  useEffect(() => {
    register(present && toggle ? { picking, disabled, toggle } : null);
  }, [register, present, picking, disabled, toggle]);
  useEffect(() => () => register(null), [register]);
}
