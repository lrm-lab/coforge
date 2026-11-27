import { expect, mock, test } from "bun:test";
import plugin from "../scripts/oxlint-plugin.js";

test("no-raw-otp-input rejects single-line Input and native input with autoComplete='one-time-code' but allows InputOTP and upstream files", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-raw-otp-input"].create({
    report,
    filename: "/repo/apps/web/src/features/auth/send-code-row.tsx",
  });
  const el = (name, autoComplete) => ({
    name: { type: "JSXIdentifier", name },
    attributes:
      autoComplete === undefined
        ? []
        : [
            {
              type: "JSXAttribute",
              name: { type: "JSXIdentifier", name: "autoComplete" },
              value: { type: "Literal", value: autoComplete },
            },
          ],
  });

  visitor.JSXOpeningElement(el("Input", "one-time-code"));
  expect(report).toHaveBeenCalledTimes(1);

  visitor.JSXOpeningElement(el("input", "one-time-code"));
  expect(report).toHaveBeenCalledTimes(2);

  visitor.JSXOpeningElement(el("InputBase", "section-login ONE-TIME-CODE"));
  expect(report).toHaveBeenCalledTimes(3);

  visitor.JSXOpeningElement(el("InputOTP", "one-time-code"));
  expect(report).toHaveBeenCalledTimes(3);

  visitor.JSXOpeningElement(el("Input", "username"));
  expect(report).toHaveBeenCalledTimes(3);

  const otpPrimitiveVisitor = plugin.rules["no-raw-otp-input"].create({
    report: mock(() => {}),
    filename: "/repo/apps/web/src/components/ui/input-otp.tsx",
  });
  expect(otpPrimitiveVisitor.JSXOpeningElement).toBeUndefined();

  const upstreamVisitor = plugin.rules["no-raw-otp-input"].create({
    report: mock(() => {}),
    filename: "/repo/apps/web/src/components/base/input/input.tsx",
  });
  expect(upstreamVisitor.JSXOpeningElement).toBeUndefined();
});
