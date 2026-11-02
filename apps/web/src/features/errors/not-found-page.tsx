import { ErrorPageFrame } from "./error-page-frame";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { SearchLg } from "@untitledui/icons";

import { EmptyState } from "#src/components/application/empty-state/empty-state";
import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";

/** The router's fallback for a URL no route matches. */
export function NotFoundPage() {
  const router = useRouter();
  const navigate = useNavigate();
  return (
    <ErrorPageFrame>
      <EmptyState size="lg">
        <EmptyState.Header>
          <EmptyState.FeaturedIcon color="gray" icon={SearchLg} />
        </EmptyState.Header>
        <EmptyState.Content>
          <EmptyState.Title>{m.not_found_title()}</EmptyState.Title>
        </EmptyState.Content>
        <EmptyState.Footer>
          {/* A link opened in a new tab has no history to go back to. */}
          {router.history.canGoBack() && (
            <Button color="secondary" onPress={() => router.history.back()}>
              {m.controls_back()}
            </Button>
          )}
          <Button onPress={() => void navigate({ to: "/" })}>{m.not_found_home()}</Button>
        </EmptyState.Footer>
      </EmptyState>
    </ErrorPageFrame>
  );
}
