import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { audit } from "../src/audit.ts";
import type { LocationData } from "../src/fake-location.ts";
import { createHttpPort } from "../src/ghl-http.ts";
import type { Rep } from "../src/model.ts";

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as T;
const location = read<LocationData>("location.json");
const reps = read<Rep[]>("reps.json");

/** Answers the three public endpoints from the fixture, two contacts per page, cursor on every page. */
function fixtureFetch() {
  const calls: { method: string; path: string }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname.endsWith("/tags")) return json({ tags: location.tags.map((name) => ({ id: `tag_${name}`, name })) });
    if (url.pathname.startsWith("/workflows")) return json({ workflows: location.workflows });
    const body = JSON.parse(String(init?.body)) as { filters: { field: string; value: string }[]; searchAfter?: [string] };
    const [filter] = body.filters;
    const after = body.searchAfter?.[0] ?? "";
    const page = location.contacts
      .filter((c) => (filter!.field === "tags" ? c.tags.includes(filter!.value) : c.assignedTo === filter!.value))
      .sort((a, b) => a.id.localeCompare(b.id)) // a cursor only works over a stable order
      .filter((c) => c.id > after)
      .slice(0, 2)
      .map((c) => ({ id: c.id, tags: c.tags, assignedTo: c.assignedTo, customFields: c.clientKey ? [{ id: "cf_client", value: c.clientKey }] : [], searchAfter: [c.id] }));
    return json({ contacts: page });
  }) as typeof fetch;
  return { calls, impl };
}

test("over HTTP: same findings as in memory, and only reads", async () => {
  const { calls, impl } = fixtureFetch();
  const report = await audit(createHttpPort({ token: "t", locationId: "loc_demo_0001", clientFieldId: "cf_client", fetch: impl }), reps);
  assert.equal(report.findings.length, 15);
  assert.ok(report.findings.some((f) => f.check === "other-client" && f.contactId === "ct_a08"), "client key read from the custom field");
  assert.ok(calls.every((c) => c.method === "GET" || (c.method === "POST" && c.path === "/contacts/search")), JSON.stringify(calls.filter((c) => c.method !== "GET")));
});

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "audit-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("exit codes: 2 when a rep cannot be verified, 1 for findings", () => {
  const all = run();
  assert.equal(all.status, 2);
  assert.match(all.stdout, /queue audit: unverified/);

  const twoReps = join(dir, "reps.json");
  writeFileSync(twoReps, JSON.stringify(reps.slice(0, 2)));
  const findings = run("--reps", twoReps);
  assert.equal(findings.status, 1);
  assert.match(findings.stdout, /queue audit: findings/);
});

test("--json carries the whole report", () => {
  const report = JSON.parse(run("--json").stdout);
  assert.equal(report.status, "unverified");
  assert.equal(report.controlled, true);
  assert.equal(report.findings.length, 15);
});

test("--live without credentials is bad input, not a silent fallback to the fixture", () => {
  const env = { ...process.env };
  delete env.GHL_API_TOKEN;
  delete env.GHL_LOCATION_ID;
  const result = spawnSync(process.execPath, [cli, "--live"], { encoding: "utf8", env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /needs GHL_API_TOKEN/);
});
