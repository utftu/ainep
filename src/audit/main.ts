import { runAudit } from "./audit.ts";

const binary = Bun.argv[2];
if (binary === undefined) {
  console.error("Usage: bun src/audit/main.ts /absolute/path/to/claude [report.json]");
  process.exitCode = 1;
} else {
  const report = await runAudit(binary).catch(() => undefined);
  if (report === undefined) {
    console.error("Audit failed. No raw client output or credentials were logged.");
    process.exitCode = 1;
  } else {
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (Bun.argv[3] !== undefined) {
      await Bun.write(Bun.argv[3], output);
    }
    console.log(output);
    if (report.scenarios.some((scenario) => !scenario.success)) {
      process.exitCode = 1;
    }
  }
}
