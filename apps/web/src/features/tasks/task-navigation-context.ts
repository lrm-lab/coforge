import { createContext, useContext, useEffect } from "react";

export type TaskDetailNavigation = {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
};

type TaskNavigationSetter = (navigation: TaskDetailNavigation | undefined) => void;

export const TaskNavigationRegistrationContext = createContext<TaskNavigationSetter | null>(null);

export function useRegisterTaskNavigation(navigation: TaskDetailNavigation | undefined) {
  const register = useContext(TaskNavigationRegistrationContext);
  useEffect(() => {
    if (!register) return;
    register(navigation);
    return () => register(undefined);
  }, [register, navigation]);
}
