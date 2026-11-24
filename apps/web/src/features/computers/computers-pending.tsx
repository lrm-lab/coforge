import { useMatch, useRouter } from "@tanstack/react-router";
import { AlertCircle } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { BackToComputers } from "./back-to-computers";

export function ComputersPending() {
  return (
    <main aria-busy="true" className="flex h-full min-w-0 flex-col overflow-hidden bg-primary">
      <p role="status" className="sr-only">
        {m.computer_loading()}
      </p>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-page">
        <h1 className="text-lg font-semibold text-primary">{m.computer_page_title()}</h1>
        <Skeleton aria-hidden="true" className="h-3.5 w-40 motion-safe:animate-pulse" />
      </header>
      <div
        aria-hidden="true"
        className="flex flex-wrap items-center gap-2 border-b border-secondary px-page py-2.5 motion-safe:animate-pulse"
      >
        <Skeleton className="h-9 w-56 rounded-lg" />
        <Skeleton className="h-9 w-24 rounded-lg" />
        <Skeleton className="h-9 w-24 rounded-lg" />
        <Skeleton className="ms-auto h-9 w-24 rounded-lg" />
      </div>
      <div
        aria-hidden="true"
        className="min-h-0 flex-1 overflow-y-auto px-page py-4 motion-safe:animate-pulse"
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="flex flex-col gap-3 rounded-xl border border-secondary bg-primary p-3.5"
            >
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-9 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/5" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
              </div>
              <Skeleton className="h-5 w-1/2" />
              <div className="grid grid-cols-2 gap-3">
                <Skeleton className="h-8 rounded-md" />
                <Skeleton className="h-8 rounded-md" />
              </div>
              <Skeleton className="h-10 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

export function ComputerDetailPending() {
  return <ComputerDetailSkeleton announce />;
}

function ComputerDetailSkeleton({ announce }: { announce: boolean }) {
  return (
    <div aria-busy={announce ? "true" : undefined} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-page">
        <BackToComputers />
        <Skeleton aria-hidden="true" className="h-5 w-48 motion-safe:animate-pulse" />
        {announce && (
          <p role="status" className="sr-only">
            {m.computer_loading()}
          </p>
        )}
      </header>
      <div
        aria-hidden="true"
        className="min-h-0 flex-1 overflow-y-auto px-page pt-6 pb-10 motion-safe:animate-pulse"
      >
        <div className="flex w-full flex-col gap-10">
          <div className="flex flex-wrap gap-x-12 gap-y-5">
            {["w-20", "w-20", "w-16", "w-36"].map((width, index) => (
              <div key={index} className="flex flex-col gap-2">
                <Skeleton className="h-3 w-12" />
                <Skeleton className={`h-4 ${width}`} />
              </div>
            ))}
          </div>
          <div>
            <Skeleton className="mb-3 h-4 w-40" />
            <div className="divide-y divide-secondary border-y border-secondary">
              {["w-36", "w-28"].map((width) => (
                <div key={width} className="flex items-center gap-3 py-3">
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <Skeleton className={`h-4 ${width}`} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ComputerDetailLoadError({ error }: { error: unknown }) {
  const router = useRouter();
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  void error;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-page">
        <BackToComputers />
        <h1 className="text-md font-medium">{m.computer_page_title()}</h1>
      </header>
      <div className="grid flex-1 place-content-center gap-4 p-6 text-center">
        <AlertCircle aria-hidden="true" className="mx-auto size-5 text-error-primary" />
        <p role="alert" className="text-sm text-error-primary">
          {m.computer_detail_load_error()}
        </p>
        <Button
          color="secondary"
          className="justify-self-center"
          onPress={() =>
            void router.invalidate({
              filter: (match) => match.routeId === routeId,
            })
          }
        >
          {m.controls_retry()}
        </Button>
      </div>
    </div>
  );
}
