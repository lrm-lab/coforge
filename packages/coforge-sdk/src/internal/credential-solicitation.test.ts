import { describe, expect, test } from "bun:test";
import { solicitsCredentialsInChat } from "./credential-solicitation";

describe("solicitsCredentialsInChat", () => {
  test("blocks clear English asks", () => {
    expect(solicitsCredentialsInChat("Please send me your password")).toBe(true);
    expect(solicitsCredentialsInChat("Paste the password here")).toBe(true);
    expect(solicitsCredentialsInChat("Type your password in the chat")).toBe(true);
    expect(solicitsCredentialsInChat("What's your password?")).toBe(true);
    expect(solicitsCredentialsInChat("Reply with the verification code")).toBe(true);
  });

  test("blocks clear Chinese asks", () => {
    expect(solicitsCredentialsInChat("请把密码发给我")).toBe(true);
    expect(solicitsCredentialsInChat("告诉我密码，我帮你登录")).toBe(true);
    expect(solicitsCredentialsInChat("把验证码发到聊天里")).toBe(true);
    expect(solicitsCredentialsInChat("密码发过来就行")).toBe(true);
    expect(solicitsCredentialsInChat("把密码输入到对话框中告诉我")).toBe(true);
  });

  test("allows negated and instructional wording", () => {
    expect(solicitsCredentialsInChat("Don't send me your password")).toBe(false);
    expect(solicitsCredentialsInChat("不要把密码发给我，用 page:fill")).toBe(false);
    expect(solicitsCredentialsInChat("禁止把验证码发到聊天")).toBe(false);
    expect(
      solicitsCredentialsInChat(
        "I posted a page:fill card for the password field. Never paste secrets into chat.",
      ),
    ).toBe(false);
  });

  test("allows ordinary talk about passwords without asking for them", () => {
    expect(solicitsCredentialsInChat("Choose password login or GitHub")).toBe(false);
    expect(solicitsCredentialsInChat("The password field is ready on the page")).toBe(false);
    expect(solicitsCredentialsInChat("Sign in with a password on the card")).toBe(false);
    expect(solicitsCredentialsInChat("hello")).toBe(false);
  });
});
