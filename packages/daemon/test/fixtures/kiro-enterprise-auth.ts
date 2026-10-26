// Native CLI fixture: no credentials, filesystem writes or network access.
const args = process.argv.slice(2);
const startUrl = "https://example.awsapps.com/start";
const region = "us-east-1";
if (args[0] === "whoami") {
  console.log(
    JSON.stringify({
      accountType: "IamIdentityCenter",
      email: "alice@example.com",
      startUrl,
      region,
    }),
  );
  console.log("Profile:\nexample");
} else if (args[0] === "login") {
  if (!process.stdin.isTTY) throw new Error("Kiro IDC needs a terminal");
  process.stdout.write(`? Enter Start URL › ${startUrl}`);
  let answers = 0;
  for await (const chunk of Bun.stdin.stream()) {
    for (const character of new TextDecoder().decode(chunk)) {
      if (character !== "\n" && character !== "\r") continue;
      answers++;
      if (answers === 1) process.stdout.write(`\n? Enter Region › ${region}`);
      if (answers === 2) {
        console.log("\nOpen https://device.sso.us-east-1.amazonaws.com/\nCode: ABCD-EFGH");
        process.exit(0);
      }
    }
  }
  process.exit(1);
} else throw new Error("Unexpected fixture command");

export {};
