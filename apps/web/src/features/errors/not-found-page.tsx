import { useNavigate, useRouter } from "@tanstack/react-router";

import { Button } from "#src/components/base/buttons/button";
import { EmptyState } from "#src/components/ui/empty";
import { LockedWireframe } from "#src/components/ui/empty-wireframes";
import { m } from "#src/paraglide/messages";
import { ErrorPageFrame } from "./error-page-frame";

export function NotFoundPage() {
  const router = useRouter();
  const navigate = useNavigate();
  return (
    <ErrorPageFrame>
      <EmptyState
        size="page"
        headingLevel={1}
        picture={<LockedWireframe />}
        title={m.not_found_title()}
        description={m.empty_not_found_description()}
        primaryAction={
          <Button onPress={() => void navigate({ to: "/" })}>{m.not_found_home()}</Button>
        }
        secondaryAction={
          router.history.canGoBack() ? (
            <Button color="tertiary" onPress={() => router.history.back()}>
              {m.controls_back()}
            </Button>
          ) : undefined
        }
      />
    </ErrorPageFrame>
  );
}
