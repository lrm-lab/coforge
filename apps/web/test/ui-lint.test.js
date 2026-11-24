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
