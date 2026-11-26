import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

const FeedbackDialog = lazy(() =>
  import("./feedback-dialog").then((module) => ({
    default: module.FeedbackDialog,
  })),
);

const OpenFeedbackContext = createContext<() => void>(() => undefined);

export function useOpenFeedback() {
  return useContext(OpenFeedbackContext);
}

export function FeedbackHost({
  workspaceId,
  workspaceName,
  children,
}: {
  workspaceId: string;
  workspaceName: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);

  return (
    <OpenFeedbackContext value={openDialog}>
      {children}
      {mounted && (
        <Suspense fallback={null}>
          <FeedbackDialog
            open={open}
            onOpenChange={setOpen}
            workspaceId={workspaceId}
            workspaceName={workspaceName}
          />
        </Suspense>
      )}
    </OpenFeedbackContext>
  );
}
