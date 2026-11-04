/**
 * Stand-in for `agy -p /usage --output-format json`. A fresh process per invocation, argv-driven,
 * no stdin. The default output is the real 1.2.13 capture in `antigravity-usage.json`;
 * `COFORGE_ANTIGRAVITY_*` env vars replace it or fail the command.
 */
const argv = process.argv.slice(2);

for (const name of ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"]) {
  if (Bun.env[name] !== undefined) {
    console.error(`${name} leaked into agy`);
    process.exit(1);
  }
}

if (argv.join(" ") === "-p /usage --output-format json") {
  process.stdout.write(
    Bun.env.COFORGE_ANTIGRAVITY_USAGE_OUTPUT ??
      (await Bun.file(new URL("./antigravity-usage.json", import.meta.url)).text()),
  );
  process.exit(Number(Bun.env.COFORGE_ANTIGRAVITY_USAGE_EXIT ?? "0"));
}

console.error(`unexpected antigravity usage fixture arguments: ${argv.join(" ")}`);
process.exit(2);
