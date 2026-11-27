import { expect, mock, test } from "bun:test";
import plugin from "../scripts/oxlint-plugin.js";

test("native-title rule allows official Tooltip title props but rejects DOM title attributes", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-native-title"].create({ report });
  const attribute = (name) => ({
    name: { type: "JSXIdentifier", name: "title" },
    parent: { name: { type: "JSXIdentifier", name } },
  });
  visitor.JSXAttribute(attribute("Tooltip"));
  expect(report).not.toHaveBeenCalled();
  visitor.JSXAttribute(attribute("button"));
  expect(report).toHaveBeenCalledTimes(1);
  visitor.JSXAttribute(attribute("span"));
  expect(report).toHaveBeenCalledTimes(2);
});

test("no-handrolled-toolbar rejects role='toolbar' on native elements but allows React Aria Toolbar and upstream files", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-handrolled-toolbar"].create({
    report,
    filename: "/repo/apps/web/src/features/conversations/bar.tsx",
  });
  const roleAttr = (elementName, value) => ({
    name: { type: "JSXIdentifier", name: "role" },
    value: { type: "Literal", value },
    parent: { name: { type: "JSXIdentifier", name: elementName } },
  });
  visitor.JSXAttribute(roleAttr("div", "toolbar"));
  expect(report).toHaveBeenCalledTimes(1);
  visitor.JSXAttribute(roleAttr("div", "dialog"));
  expect(report).toHaveBeenCalledTimes(1);
  visitor.JSXAttribute(roleAttr("Toolbar", "toolbar"));
  expect(report).toHaveBeenCalledTimes(1);

  const upstreamReport = mock(() => {});
  const upstreamVisitor = plugin.rules["no-handrolled-toolbar"].create({
    report: upstreamReport,
    filename: "/repo/apps/web/src/components/base/foo.tsx",
  });
  expect(upstreamVisitor.JSXAttribute).toBeUndefined();
});

test("prefer-on-press rejects onClick on Button and AriaButton but allows ButtonUtility and upstream files", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["prefer-on-press"].create({
    report,
    filename: "/repo/apps/web/src/features/conversations/bar.tsx",
  });
  const clickAttr = (elementName, propName = "onClick") => ({
    name: { type: "JSXIdentifier", name: propName },
    parent: { name: { type: "JSXIdentifier", name: elementName } },
  });
  visitor.JSXAttribute(clickAttr("Button"));
  expect(report).toHaveBeenCalledTimes(1);
  visitor.JSXAttribute(clickAttr("AriaButton"));
  expect(report).toHaveBeenCalledTimes(2);
  visitor.JSXAttribute(clickAttr("Button", "onPress"));
  expect(report).toHaveBeenCalledTimes(2);
  visitor.JSXAttribute(clickAttr("ButtonUtility"));
  expect(report).toHaveBeenCalledTimes(2);

  const upstreamReport = mock(() => {});
  const upstreamVisitor = plugin.rules["prefer-on-press"].create({
    report: upstreamReport,
    filename: "/repo/apps/web/src/components/application/file-upload/file-upload-base.tsx",
  });
  expect(upstreamVisitor.JSXAttribute).toBeUndefined();
});

test("no-custom-hover-delay rejects delay/closeDelay on Tooltip and HoverPopover outside primitives", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-custom-hover-delay"].create({
    report,
    filename: "/repo/apps/web/src/features/agents/row.tsx",
  });
  const prop = (component, name) => ({
    name: { type: "JSXIdentifier", name },
    parent: { name: { type: "JSXIdentifier", name: component } },
  });
  visitor.JSXAttribute(prop("Tooltip", "delay"));
  expect(report).toHaveBeenCalledTimes(1);
  visitor.JSXAttribute(prop("HoverPopover", "closeDelay"));
  expect(report).toHaveBeenCalledTimes(2);
  visitor.JSXAttribute(prop("Tooltip", "placement"));
  expect(report).toHaveBeenCalledTimes(2);

  const primitiveReport = mock(() => {});
  const primitiveVisitor = plugin.rules["no-custom-hover-delay"].create({
    report: primitiveReport,
    filename: "/repo/apps/web/src/components/ui/hover-popover.tsx",
  });
  expect(primitiveVisitor.JSXAttribute).toBeUndefined();
});

test("no-raw-hover-primitives rejects direct PreviewTrigger and TooltipTrigger imports outside primitives", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-raw-hover-primitives"].create({
    report,
    filename: "/repo/apps/web/src/features/tasks/chip.tsx",
  });
  visitor.ImportDeclaration({
    source: { value: "react-aria-components" },
    specifiers: [
      { type: "ImportSpecifier", imported: { name: "PreviewTrigger" } },
      { type: "ImportSpecifier", imported: { name: "Button" } },
      { type: "ImportSpecifier", imported: { name: "TooltipTrigger" } },
    ],
  });
  expect(report).toHaveBeenCalledTimes(2);
});

test("no-hover-input-submenu rejects PickerMenu inside hover-opened Dropdown.SubmenuTrigger unless openOnHover={false}", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-hover-input-submenu"].create({ report });
  const makeSubmenu = (attributes) => ({
    type: "JSXElement",
    openingElement: {
      name: {
        type: "JSXMemberExpression",
        object: { type: "JSXIdentifier", name: "Dropdown" },
        property: { type: "JSXIdentifier", name: "SubmenuTrigger" },
      },
      attributes,
    },
    children: [
      {
        type: "JSXElement",
        openingElement: { name: { type: "JSXIdentifier", name: "PickerMenu" }, attributes: [] },
        children: [],
      },
    ],
  });
  visitor.JSXElement(makeSubmenu([]));
  expect(report).toHaveBeenCalledTimes(1);
  visitor.JSXElement(
    makeSubmenu([
      {
        type: "JSXAttribute",
        name: { type: "JSXIdentifier", name: "openOnHover" },
        value: { type: "JSXExpressionContainer", expression: { type: "Literal", value: false } },
      },
    ]),
  );
  expect(report).toHaveBeenCalledTimes(1);
});

test("no-sync-motion-import rejects synchronous motion from motion/react but allows AnimatePresence", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-sync-motion-import"].create({ report });
  visitor.ImportDeclaration({
    source: { value: "motion/react" },
    specifiers: [
      { type: "ImportSpecifier", imported: { name: "motion" } },
      { type: "ImportSpecifier", imported: { name: "AnimatePresence" } },
    ],
  });
  expect(report).toHaveBeenCalledTimes(1);
});

test("no-browser-dialogs rejects window.confirm/alert/prompt and allows local confirm helpers", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-browser-dialogs"].create({ report });
  visitor.CallExpression({
    callee: {
      type: "MemberExpression",
      computed: false,
      object: { type: "Identifier", name: "window" },
      property: { type: "Identifier", name: "confirm" },
    },
  });
  visitor.CallExpression({
    callee: { type: "Identifier", name: "confirm" },
  });
  expect(report).toHaveBeenCalledTimes(1);
});

test("no-raw-toast-library rejects sonner and react-hot-toast imports", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-raw-toast-library"].create({ report });
  visitor.ImportDeclaration({ source: { value: "sonner" } });
  visitor.ImportDeclaration({ source: { value: "#src/components/ui/toast" } });
  expect(report).toHaveBeenCalledTimes(1);
});

test("no-raw-file-type-icon rejects direct @untitledui/file-icons outside features/files", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-raw-file-type-icon"].create({
    report,
    filename: "/repo/apps/web/src/features/artifacts/card.tsx",
  });
  visitor.ImportDeclaration({ source: { value: "@untitledui/file-icons" } });
  expect(report).toHaveBeenCalledTimes(1);

  const allowedVisitor = plugin.rules["no-raw-file-type-icon"].create({
    report: mock(() => {}),
    filename: "/repo/apps/web/src/features/files/file-type-icon.tsx",
  });
  expect(allowedVisitor.ImportDeclaration).toBeUndefined();
});

test("no-distracting-animations rejects animate-bounce and animate-ping in className", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-distracting-animations"].create({
    report,
    filename: "/repo/apps/web/src/features/tasks/row.tsx",
  });
  visitor.JSXAttribute({
    name: { type: "JSXIdentifier", name: "className" },
    value: { type: "Literal", value: "size-2 animate-ping rounded-full" },
  });
  visitor.JSXAttribute({
    name: { type: "JSXIdentifier", name: "className" },
    value: {
      type: "JSXExpressionContainer",
      expression: {
        type: "CallExpression",
        arguments: [{ type: "Literal", value: "animate-pulse" }],
      },
    },
  });
  expect(report).toHaveBeenCalledTimes(1);
});

test("no-handrolled-date-math rejects legacy Date calendar methods and multi-arg new Date in src", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-handrolled-date-math"].create({
    report,
    filename: "/repo/apps/web/src/features/records/window.ts",
  });
  const callMethod = (name) => ({
    callee: {
      type: "MemberExpression",
      computed: false,
      object: { type: "Identifier", name: "date" },
      property: { type: "Identifier", name },
    },
  });
  visitor.CallExpression(callMethod("setUTCDate"));
  visitor.CallExpression(callMethod("getFullYear"));
  visitor.CallExpression(callMethod("getTimezoneOffset"));
  visitor.CallExpression(callMethod("getTime"));
  visitor.CallExpression(callMethod("toISOString"));
  visitor.NewExpression({
    callee: { type: "Identifier", name: "Date" },
    arguments: [
      { type: "Literal", value: 2026 },
      { type: "Literal", value: 8 },
    ],
  });
  visitor.NewExpression({
    callee: { type: "Identifier", name: "Date" },
    arguments: [{ type: "Literal", value: "2026-09-18T00:00:00Z" }],
  });
  expect(report).toHaveBeenCalledTimes(4);

  const testFileVisitor = plugin.rules["no-handrolled-date-math"].create({
    report: mock(() => {}),
    filename: "/repo/apps/web/test/window.test.ts",
  });
  expect(testFileVisitor.CallExpression).toBeUndefined();

  const upstreamVisitor = plugin.rules["no-handrolled-date-math"].create({
    report: mock(() => {}),
    filename: "/repo/apps/web/src/components/base/calendar.tsx",
  });
  expect(upstreamVisitor.CallExpression).toBeUndefined();
});

test("no-handrolled-resize-handle rejects interactive native role='separator' but allows static dividers and Separator component", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-handrolled-resize-handle"].create({
    report,
    filename: "/repo/apps/web/src/features/conversations/handle.tsx",
  });
  const el = (name, attrs) => ({
    name: { type: "JSXIdentifier", name },
    attributes: attrs.map(([attrName, value]) => ({
      type: "JSXAttribute",
      name: { type: "JSXIdentifier", name: attrName },
      value: value === undefined ? null : { type: "Literal", value },
    })),
  });
  visitor.JSXOpeningElement(
    el("div", [
      ["role", "separator"],
      ["onPointerDown", undefined],
    ]),
  );
  expect(report).toHaveBeenCalledTimes(1);
  visitor.JSXOpeningElement(
    el("div", [
      ["role", "separator"],
      ["tabIndex", 0],
    ]),
  );
  expect(report).toHaveBeenCalledTimes(2);
  visitor.JSXOpeningElement(
    el("div", [
      ["role", "separator"],
      ["aria-label", "New messages"],
    ]),
  );
  expect(report).toHaveBeenCalledTimes(2);
  visitor.JSXOpeningElement(
    el("Separator", [
      ["role", "separator"],
      ["onPointerDown", undefined],
    ]),
  );
  expect(report).toHaveBeenCalledTimes(2);
});

test("no-dt-colon rejects trailing ASCII and full-width colons in <dt> labels", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-dt-colon"].create({
    report,
    filename: "/repo/apps/web/src/features/apps/status.tsx",
  });
  const dtWithChildren = (children) => ({
    type: "JSXElement",
    openingElement: { name: { type: "JSXIdentifier", name: "dt" }, attributes: [] },
    children,
  });

  visitor.JSXElement(dtWithChildren([{ type: "JSXText", value: "Status: " }]));
  expect(report).toHaveBeenCalledTimes(1);

  visitor.JSXElement(
    dtWithChildren([
      { type: "JSXExpressionContainer", expression: { type: "Identifier", name: "label" } },
      { type: "JSXText", value: "：" },
    ]),
  );
  expect(report).toHaveBeenCalledTimes(2);

  visitor.JSXElement(
    dtWithChildren([
      { type: "JSXExpressionContainer", expression: { type: "Literal", value: "Host:" } },
    ]),
  );
  expect(report).toHaveBeenCalledTimes(3);

  visitor.JSXElement(
    dtWithChildren([
      {
        type: "JSXExpressionContainer",
        expression: {
          type: "TemplateLiteral",
          quasis: [{ value: { cooked: "Region：", raw: "Region：" } }],
          expressions: [],
        },
      },
    ]),
  );
  expect(report).toHaveBeenCalledTimes(4);

  visitor.JSXElement({
    type: "JSXElement",
    openingElement: {
      name: { type: "JSXIdentifier", name: "KeyValueRow" },
      attributes: [
        {
          type: "JSXAttribute",
          name: { type: "JSXIdentifier", name: "label" },
          value: { type: "Literal", value: "Owner:" },
        },
      ],
    },
    children: [],
  });
  expect(report).toHaveBeenCalledTimes(5);

  visitor.JSXElement(dtWithChildren([{ type: "JSXText", value: "HTTP: Status" }]));
  expect(report).toHaveBeenCalledTimes(5);

  visitor.JSXElement(
    dtWithChildren([
      { type: "JSXExpressionContainer", expression: { type: "Identifier", name: "label" } },
    ]),
  );
  expect(report).toHaveBeenCalledTimes(5);

  const upstreamVisitor = plugin.rules["no-dt-colon"].create({
    report: mock(() => {}),
    filename: "/repo/apps/web/src/components/base/foo.tsx",
  });
  expect(upstreamVisitor.JSXElement).toBeUndefined();
});

test("no-ragged-dl rejects horizontal flex <dt>/<dd> rows without fixed label width or edge alignment", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-ragged-dl"].create({
    report,
    filename: "/repo/apps/web/src/features/apps/webhook-delivery-status.tsx",
  });
  const classAttr = (value) =>
    value === undefined
      ? []
      : [
          {
            type: "JSXAttribute",
            name: { type: "JSXIdentifier", name: "className" },
            value: { type: "Literal", value },
          },
        ];
  const makeRowInDl = ({ rowClass, dtClass, ddClass }) => ({
    type: "JSXElement",
    openingElement: { name: { type: "JSXIdentifier", name: "dl" }, attributes: [] },
    children: [
      {
        type: "JSXElement",
        openingElement: {
          name: { type: "JSXIdentifier", name: "div" },
          attributes: classAttr(rowClass),
        },
        children: [
          {
            type: "JSXElement",
            openingElement: {
              name: { type: "JSXIdentifier", name: "dt" },
              attributes: classAttr(dtClass),
            },
            children: [],
          },
          {
            type: "JSXElement",
            openingElement: {
              name: { type: "JSXIdentifier", name: "dd" },
              attributes: classAttr(ddClass),
            },
            children: [],
          },
        ],
      },
    ],
  });

  visitor.JSXElement(
    makeRowInDl({
      rowClass: "flex flex-wrap gap-x-2",
      dtClass: "text-tertiary",
      ddClass: "text-secondary",
    }),
  );
  expect(report).toHaveBeenCalledTimes(1);

  visitor.JSXElement(
    makeRowInDl({
      rowClass: "flex items-baseline gap-2",
      dtClass: "text-tertiary",
      ddClass: "text-primary",
    }),
  );
  expect(report).toHaveBeenCalledTimes(2);

  visitor.JSXElement(
    makeRowInDl({
      rowClass: "flex min-h-8 items-center gap-3",
      dtClass: "w-20 shrink-0 text-tertiary",
      ddClass: "flex-1",
    }),
  );
  expect(report).toHaveBeenCalledTimes(2);

  visitor.JSXElement(
    makeRowInDl({
      rowClass: "flex flex-wrap items-center gap-x-3",
      dtClass: "text-primary",
      ddClass: "ms-auto text-tertiary",
    }),
  );
  expect(report).toHaveBeenCalledTimes(2);

  visitor.JSXElement(
    makeRowInDl({
      rowClass: "flex justify-between gap-4",
      dtClass: "text-tertiary",
      ddClass: "text-primary",
    }),
  );
  expect(report).toHaveBeenCalledTimes(2);

  visitor.JSXElement(
    makeRowInDl({
      rowClass: "flex flex-col gap-0.5",
      dtClass: "text-tertiary",
      ddClass: "text-primary",
    }),
  );
  expect(report).toHaveBeenCalledTimes(2);

  visitor.JSXElement(
    makeRowInDl({
      rowClass: "flex-1",
      dtClass: "text-tertiary",
      ddClass: "text-primary",
    }),
  );
  expect(report).toHaveBeenCalledTimes(2);

  visitor.JSXElement(
    makeRowInDl({
      rowClass: "flex gap-2",
      dtClass: "min-w-0 text-tertiary",
      ddClass: "text-primary",
    }),
  );
  expect(report).toHaveBeenCalledTimes(3);
});

test("no-hinted-radio-button rejects RadioButton with hint prop but allows plain RadioButton and upstream files", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-hinted-radio-button"].create({
    report,
    filename: "/repo/apps/web/src/features/computers/kiro-enterprise-sign-in.tsx",
  });
  const radioEl = (name, attrs) => ({
    name: { type: "JSXIdentifier", name },
    attributes: attrs,
  });

  visitor.JSXOpeningElement(
    radioEl("RadioButton", [
      {
        type: "JSXAttribute",
        name: { type: "JSXIdentifier", name: "label" },
        value: { type: "Literal", value: "Free" },
      },
      {
        type: "JSXAttribute",
        name: { type: "JSXIdentifier", name: "hint" },
        value: { type: "Literal", value: "Builder ID" },
      },
    ]),
  );
  expect(report).toHaveBeenCalledTimes(1);

  visitor.JSXOpeningElement(
    radioEl("RadioButton", [
      {
        type: "JSXAttribute",
        name: { type: "JSXIdentifier", name: "label" },
        value: { type: "Literal", value: "Personal" },
      },
    ]),
  );
  expect(report).toHaveBeenCalledTimes(1);

  for (const emptyVal of [
    { type: "JSXExpressionContainer", expression: { type: "Identifier", name: "undefined" } },
    { type: "JSXExpressionContainer", expression: { type: "Literal", value: null } },
    { type: "JSXExpressionContainer", expression: { type: "Literal", value: false } },
    { type: "Literal", value: "" },
  ]) {
    visitor.JSXOpeningElement(
      radioEl("RadioButton", [
        { type: "JSXAttribute", name: { type: "JSXIdentifier", name: "hint" }, value: emptyVal },
      ]),
    );
  }
  expect(report).toHaveBeenCalledTimes(1);

  visitor.JSXOpeningElement(
    radioEl("RadioButton", [
      { type: "JSXAttribute", name: { type: "JSXIdentifier", name: "hint" }, value: null },
    ]),
  );
  expect(report).toHaveBeenCalledTimes(2);

  visitor.JSXOpeningElement(
    radioEl("Checkbox", [
      {
        type: "JSXAttribute",
        name: { type: "JSXIdentifier", name: "hint" },
        value: { type: "Literal", value: "Required" },
      },
    ]),
  );
  expect(report).toHaveBeenCalledTimes(2);

  const upstreamVisitor = plugin.rules["no-hinted-radio-button"].create({
    report: mock(() => {}),
    filename: "/repo/apps/web/src/components/base/radio-buttons/radio-buttons.tsx",
  });
  expect(upstreamVisitor.JSXOpeningElement).toBeUndefined();
});
