import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { audit, DEFAULT_OPTIONS } from "../src/audit.ts";
import { FakeLocation, type LocationData } from "../src/fake-location.ts";
import type { AuditPort, Finding, Rep } from "../src/model.ts";

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as T;
const location = read<LocationData>("location.json");
const reps = read<Rep[]>("reps.json");
const [avery, jordan] = reps as [Rep, Rep];
const brief = (findings: Finding[]) => findings.map((f) => `${f.severity} ${f.check} ${f.repId}${f.contactId ? `/${f.contactId}` : ""}`);

/** Avery's clean contacts, the control contact and the tags and workflow they need. */
const cleanLocation: LocationData = {
  tags: ["dialer-queue-avery", "audit-control"],
  workflows: [{ id: "wf_demo_0001", name: "Dialer Queue - Avery", status: "published" }],
  contacts: [...location.contacts.filter((c) => /^ct_a0[1-5]$/.test(c.id)), { id: "ct_x01", tags: ["audit-control"] }],
};

test("finds every contamination seeded in the fixture, and nothing else", async () => {
  const report = await audit(new FakeLocation(location), reps);
  assert.deepEqual(brief(report.findings), [
    "ERROR inactive-owner rep_avery/ct_a06",
    "ERROR inactive-owner rep_avery/ct_a07",
    "ERROR other-client rep_avery/ct_a08",
    "ERROR multiple-queues rep_avery/ct_a09",
    "WARN no-owner rep_avery/ct_a10",
    "WARN possible-ghost rep_avery/ct_g03",
    "ERROR workflow rep_jordan",
    "ERROR wrong-owner rep_jordan/ct_a09",
    "ERROR other-client rep_jordan/ct_a09",
    "ERROR wrong-owner rep_jordan/ct_j05",
    "WARN possible-ghost rep_jordan/ct_g01",
    "WARN offboarding rep_casey",
    "ERROR offboarding rep_casey",
    "ERROR control rep_riley",
    "ERROR workflow rep_riley",
  ]);
  assert.equal(report.status, "unverified", "Riley's queue tag does not exist, so Riley cannot be audited");
  assert.deepEqual(report.reps.map((r) => [r.repId, r.queueSize, r.verified]), [
    ["rep_avery", 10, true],
    ["rep_jordan", 6, true],
    ["rep_casey", 3, true],
    ["rep_riley", 0, false],
  ]);
});

test("a booked contact owned by a rep is not a ghost", async () => {
  const report = await audit(new FakeLocation(location), reps);
  assert.ok(!report.findings.some((f) => f.contactId === "ct_g02"));
});

test("a clean location with a working control is clean", async () => {
  const report = await audit(new FakeLocation(cleanLocation), [avery]);
  assert.deepEqual(report.findings, []);
  assert.equal(report.status, "clean");
  assert.equal(report.controlled, true);
});

test("a broken search is caught by the control instead of reading as a clean audit", async () => {
  const broken = new FakeLocation(cleanLocation);
  broken.brokenSearch = true;
  const report = await audit(broken, [avery]);
  assert.equal(report.status, "unverified");
  assert.equal(report.controlled, false);
  assert.match(report.findings[0]?.message ?? "", /control search for "audit-control" found nobody/);
  assert.equal(report.reps[0]?.queueSize, 0, "the same zero a clean queue would show");
  assert.equal(report.reps[0]?.verified, false);
});

test("without a control tag the audit never says clean", async () => {
  const report = await audit(new FakeLocation(cleanLocation), [avery], { ...DEFAULT_OPTIONS, controlTag: undefined });
  assert.equal(report.status, "unverified");
  assert.deepEqual(brief(report.findings), ["WARN control *"]);
});

test("pages are followed by cursor until an empty page, whatever the page size", async () => {
  for (const pageSize of [1, 2, 100]) {
    const report = await audit(new FakeLocation(location, pageSize), [avery]);
    assert.equal(report.reps[0]?.queueSize, 10, `page size ${pageSize}`);
  }
});

test("a cursor that never advances stops the audit with an error instead of looping", async () => {
  const stuck: AuditPort = {
    listTags: async () => ["dialer-queue-avery", "audit-control"],
    listWorkflows: async () => [{ id: "wf", name: "Dialer Queue - Avery", status: "published" }],
    searchContacts: async () => ({ contacts: [{ id: "x", tags: ["audit-control"] }], next: ["x"] }),
  };
  await assert.rejects(audit(stuck, [avery]), /cursor did not advance/);
});

test("a draft workflow for an active rep is flagged: tagged contacts never reach the call queue", async () => {
  const drafted = { ...cleanLocation, workflows: [{ id: "wf_demo_0001", name: "Dialer Queue - Avery", status: "draft" }] };
  const report = await audit(new FakeLocation(drafted), [avery]);
  assert.deepEqual(brief(report.findings), ["WARN workflow rep_avery"]);
  assert.equal(report.status, "findings");
});

test("the audit only reads", async () => {
  const fake = new FakeLocation(location);
  await audit(fake, [avery, jordan]);
  assert.ok(fake.searches.length > 0);
  assert.equal(Object.getOwnPropertyNames(Object.getPrototypeOf(fake)).filter((m) => !["constructor", "listTags", "listWorkflows", "searchContacts"].includes(m)).length, 0);
});
