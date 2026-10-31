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

test("a broken owner search is caught too: the tag search working does not make 'no ghosts' true", async () => {
  const withGhost: LocationData = { ...cleanLocation, contacts: [...cleanLocation.contacts, { id: "ct_g99", tags: ["newsletter"], assignedTo: avery.ghlUserId }] };
  assert.deepEqual(brief((await audit(new FakeLocation(withGhost), [avery])).findings), ["WARN possible-ghost rep_avery/ct_g99"]);

  const broken = new FakeLocation(withGhost);
  broken.brokenSearch = "owner";
  const report = await audit(broken, [avery]);
  assert.equal(report.status, "unverified");
  assert.equal(report.controlled, true, "the tag control passes: it only checks the tag shape");
  assert.deepEqual(brief(report.findings), ["ERROR control rep_avery"]);
  assert.match(report.findings[0]?.message ?? "", /owner search missed 5 of the 5/);
});

test("a rep whose owner search has nothing to be checked against is unverified, unless another rep's was checked", async () => {
  const base: LocationData = {
    tags: ["dialer-queue-avery", "dialer-queue-jordan", "audit-control"],
    workflows: [
      { id: "wf_demo_0001", name: "Dialer Queue - Avery", status: "published" },
      { id: "wf_demo_0002", name: "Dialer Queue - Jordan", status: "published" },
    ],
    contacts: [{ id: "ct_x01", tags: ["audit-control"] }],
  };
  const alone = await audit(new FakeLocation(base), [avery]);
  assert.equal(alone.status, "unverified");
  assert.deepEqual(brief(alone.findings), ["WARN control rep_avery"]);

  const withJordan = { ...base, contacts: [...base.contacts, { id: "ct_j01", tags: ["dialer-queue-jordan"], assignedTo: jordan.ghlUserId, clientKey: "prairie" }] };
  const report = await audit(new FakeLocation(withJordan), [avery, jordan]);
  assert.equal(report.status, "clean", "Jordan's check proves the owner filter shape for Avery too");
});

test("multiple-queues does not depend on the order the tags come back in", async () => {
  const verdict = async (tags: string[]) => {
    const data: LocationData = {
      tags: ["dialer-queue-avery", "dialer-queue-casey", "audit-control"],
      workflows: [{ id: "wf_demo_0001", name: "Dialer Queue - Avery", status: "published" }],
      contacts: [{ id: "ct_m01", tags, assignedTo: avery.ghlUserId }, { id: "ct_x01", tags: ["audit-control"] }],
    };
    return brief((await audit(new FakeLocation(data), [avery])).findings);
  };
  const expected = ["ERROR multiple-queues rep_avery/ct_m01"];
  assert.deepEqual(await verdict(["dialer-queue-avery", "dialer-queue-casey"]), expected);
  assert.deepEqual(await verdict(["dialer-queue-casey", "dialer-queue-avery"]), expected, "the other queue tag first");
  assert.deepEqual(await verdict(["dialer-queue-gone", "dialer-queue-avery"]), expected, "an orphan queue tag first");
});

test("an empty roster reads nothing and is never clean, and a failed control is unverified whatever else was found", async () => {
  const empty = await audit(new FakeLocation(cleanLocation), []);
  assert.equal(empty.status, "unverified");
  assert.deepEqual(brief(empty.findings), ["ERROR control *"]);

  const broken = new FakeLocation(cleanLocation);
  broken.brokenSearch = true;
  assert.equal((await audit(broken, [])).status, "unverified");
});

test("without a control tag the audit never says clean", async () => {
  const report = await audit(new FakeLocation(cleanLocation), [avery], { ...DEFAULT_OPTIONS, controlTag: undefined });
  assert.equal(report.status, "unverified");
  assert.deepEqual(brief(report.findings), ["WARN control *"]);
});

test("pages are followed by cursor until an empty page, whatever the page size, and a short page is not the end", async () => {
  for (const pageSize of [1, 2, 100]) {
    const report = await audit(new FakeLocation(location, pageSize), [avery]);
    assert.equal(report.reps[0]?.queueSize, 10, `page size ${pageSize}`);
  }
  for (const shortPageAt of [0, 1, 2]) {
    const fake = new FakeLocation(location, 3);
    fake.shortPageAt = shortPageAt;
    assert.equal((await audit(fake, [avery])).reps[0]?.queueSize, 10, `short page at ${shortPageAt}`);
  }
});

/** A port over the fixture that pages by `size` and lets a test bend the cursor. */
const pagedPort = (size: number, cursorFor: (page: number, lastId: string) => unknown[] | undefined): AuditPort => {
  const fake = new FakeLocation(location);
  let page = 0;
  return {
    listTags: () => fake.listTags(),
    listWorkflows: () => fake.listWorkflows(),
    searchContacts: async (filter, searchAfter) => {
      page = searchAfter ? page + 1 : 0;
      const all = location.contacts
        .filter((c) => ("tag" in filter ? c.tags.includes(filter.tag) : c.assignedTo === filter.assignedTo))
        .sort((a, b) => a.id.localeCompare(b.id));
      const contacts = all.slice(page * size, page * size + size);
      const next = contacts.length ? cursorFor(page, contacts.at(-1)!.id) : undefined;
      return next ? { contacts, next } : { contacts };
    },
  };
};

test("a full page with no cursor is a broken read, never a shorter queue called clean", async () => {
  // Avery's queue has 10 contacts; pages of 4 and no cursor on page 2 would stop at 8.
  const report = await audit(pagedPort(4, (page, last) => (page === 1 ? undefined : [last])), [avery]);
  assert.equal(report.status, "unverified");
  assert.equal(report.reps[0]?.verified, false);
  assert.ok(report.findings.some((f) => f.check === "control" && f.repId === "rep_avery" && /no cursor/.test(f.message)));
  assert.ok(!report.findings.some((f) => f.check === "inactive-owner"), "a list not read to the end is not audited as if it were");
});

test("a cursor that alternates, or comes back to where it was, stops with a finding instead of paging forever", async () => {
  for (const cursorFor of [(page: number) => [page % 2 ? "b" : "a"], () => ["same"]]) {
    let requests = 0;
    const counting = pagedPort(1, cursorFor);
    const port: AuditPort = { ...counting, searchContacts: (f, after) => (requests++, counting.searchContacts(f, after)) };
    const report = await audit(port, [avery]);
    assert.equal(report.status, "unverified");
    assert.ok(requests < 50, `stopped after ${requests} requests`);
  }
});

test("a cursor that keeps changing while the same contacts come back stops with a finding", async () => {
  let page = 0;
  const fake = new FakeLocation(location);
  const port: AuditPort = {
    listTags: () => fake.listTags(),
    listWorkflows: () => fake.listWorkflows(),
    searchContacts: async (filter, searchAfter) => {
      page = searchAfter ? page + 1 : 0;
      const first = location.contacts.filter((c) => ("tag" in filter ? c.tags.includes(filter.tag) : c.assignedTo === filter.assignedTo)).slice(0, 2);
      return { contacts: first, next: [`fresh-${page}`] };
    },
  };
  const report = await audit(port, [avery]);
  assert.equal(report.status, "unverified");
  assert.ok(report.findings.some((f) => /added no new contact/.test(f.message)));
});

test("a tag filter that over-matches is caught: contacts without the tag do not count as the queue", async () => {
  const withNearMiss: LocationData = { ...cleanLocation, contacts: [...cleanLocation.contacts, { id: "ct_old_01", tags: ["dialer-queue-avery-2024"], assignedTo: jordan.ghlUserId }] };
  const fake = new FakeLocation(withNearMiss);
  fake.substringTags = true;
  const report = await audit(fake, [avery]);
  assert.equal(report.status, "unverified");
  assert.ok(report.findings.some((f) => f.check === "control" && /over-matches/.test(f.message)));
  assert.ok(!report.findings.some((f) => f.check === "wrong-owner"), "the stray contact is not judged as queued");
});

test("a missing workflow is a finding, but the queue is still read: a departed rep's leftovers are caught", async () => {
  const casey = reps.find((r) => r.id === "rep_casey")!;
  const noWorkflow = { ...location, workflows: location.workflows.filter((w) => w.name !== casey.workflowName) };
  const report = await audit(new FakeLocation(noWorkflow), [casey]);
  assert.deepEqual(brief(report.findings), ["ERROR workflow rep_casey", "ERROR offboarding rep_casey"]);
  assert.equal(report.reps[0]?.queueSize, 3);
});

test("a control tag that no longer exists is reported as missing, not as a broken search", async () => {
  const report = await audit(new FakeLocation({ ...cleanLocation, tags: ["dialer-queue-avery"] }), [avery]);
  assert.match(report.findings[0]?.message ?? "", /control tag "audit-control" does not exist in the location/);
  assert.equal(report.status, "unverified");
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
