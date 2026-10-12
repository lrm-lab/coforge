import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { AvatarPicker } from "#src/features/profiles/avatar-picker";
import { m } from "#src/paraglide/messages";

test("PageHeader renders a breadcrumb trail in place of its plain heading", () => {
  const markup = renderToStaticMarkup(
    <PageHeader
      heading={m.settings_account()}
      breadcrumb={
        <nav aria-label={m.settings_account()} className="flex items-center gap-2">
          <Button type="button" color="link-gray" size="sm">
            {m.settings_profile()}
          </Button>
          <h1 aria-current="page">{m.settings_avatar_choose()}</h1>
        </nav>
      }
    />,
  );
  // The trail takes the heading's slot: the section's static title text is gone, the current
  // crumb is the row's h1.
  expect(markup).not.toContain(`<h1>${m.settings_account()}</h1>`);
  expect(markup).toContain(m.settings_profile());
  expect(markup).toContain(m.settings_avatar_choose());
  expect(markup).toContain('aria-current="page"');
});

test("PageHeader without a breadcrumb still renders its plain heading", () => {
  const markup = renderToStaticMarkup(<PageHeader heading={m.settings_account()} />);
  expect(markup).toContain(`<h1 class="truncate text-lg font-semibold text-primary">`);
  expect(markup).toContain(m.settings_account());
});

test("AvatarPicker starts with its content; the breadcrumb moved into the page header", () => {
  const markup = renderToStaticMarkup(
    <AvatarPicker
      name="Frank"
      currentAvatarUrl={null}
      onSave={async () => {}}
      onClose={() => {}}
    />,
  );
  expect(markup).not.toContain("<nav");
  expect(markup).not.toContain(m.settings_profile());
  // The picker's own heading is still where it was.
  expect(markup).toContain(m.settings_avatar_picker_title());
});
