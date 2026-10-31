import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { audit, DEFAULT_OPTIONS, type AuditReport } from "./audit.ts";
import { FakeLocation, type LocationData } from "./fake-location.ts";
import { createHttpPort } from "./ghl-http.ts";
import type { AuditPort, Rep } from "./model.ts";

const USAGE = `usage: node src/cli.ts [--reps fixtures/reps.json] [--json] [--live] [--control-tag audit-control]

Without --live it audits fixtures/location.json in memory. With --live it reads the
location in GHL_LOCATION_ID with GHL_API_TOKEN (read only); CLIENT_FIELD_ID names the
contact custom field that holds the client key.

exit codes: 0 clean, 1 findings, 2 unverified (a control failed) or bad input`;

try {
  const { values } = parseArgs({
    options: {
      reps: { type: "string", default: "fixtures/reps.json" },
      json: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      "control-tag": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const reps = JSON.parse(readFileSync(values.reps, "utf8")) as Rep[];
  let port: AuditPort;
  if (values.live) {
    const token = process.env.GHL_API_TOKEN;
    const locationId = process.env.GHL_LOCATION_ID;
    if (!token || !locationId) throw new Error("--live needs GHL_API_TOKEN and GHL_LOCATION_ID");
    port = createHttpPort({ token, locationId, ...(process.env.CLIENT_FIELD_ID ? { clientFieldId: process.env.CLIENT_FIELD_ID } : {}) });
  } else {
    port = new FakeLocation(JSON.parse(readFileSync(new URL("../fixtures/location.json", import.meta.url), "utf8")) as LocationData);
  }

  const report = await audit(port, reps, { ...DEFAULT_OPTIONS, ...(values["control-tag"] ? { controlTag: values["control-tag"] } : {}) });
  console.log(values.json ? JSON.stringify(report, null, 2) : format(report));
  process.exitCode = report.status === "clean" ? 0 : report.status === "findings" ? 1 : 2;
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 2;
}

function format(report: AuditReport): string {
  const lines = [
    `queue audit: ${report.status}${report.controlled ? "" : " (control search did not confirm the search works)"}`,
    "",
    `${"rep".padEnd(16)}${"active".padEnd(8)}${"verified".padEnd(10)}${"queue".padStart(6)}${"errors".padStart(8)}${"warns".padStart(7)}`,
    ...report.reps.map(
      (r) => `${r.name.padEnd(16)}${(r.active ? "yes" : "no").padEnd(8)}${(r.verified ? "yes" : "NO").padEnd(10)}${String(r.queueSize).padStart(6)}${String(r.errors).padStart(8)}${String(r.warnings).padStart(7)}`,
    ),
  ];
  for (const rep of ["*", ...report.reps.map((r) => r.repId)]) {
    const mine = report.findings.filter((f) => f.repId === rep);
    if (!mine.length) continue;
    lines.push("", rep === "*" ? "audit" : rep);
    for (const f of mine) lines.push(`  ${f.severity.padEnd(5)} ${f.check.padEnd(16)}${f.contactId ? `${f.contactId}  ` : ""}${f.message}`);
  }
  return lines.join("\n");
}
