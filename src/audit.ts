import type { AuditPort, Contact, Finding, Rep, SearchFilter } from "./model.ts";

export interface AuditOptions {
  /** Contacts with any of these tags may be owned by a rep without being in a queue. */
  protectedTags: string[];
  /** Tags that mark a dialer queue; used to spot contacts in more than one. */
  queueTagPrefix: string;
  /**
   * A tag deliberately kept on at least one contact. Searching for it must find
   * someone; if it finds nobody, the search itself is broken and no empty result
   * can be trusted. Without it, the audit never reports "clean".
   */
  controlTag?: string;
}

export const DEFAULT_OPTIONS: AuditOptions = { protectedTags: ["booked", "customer"], queueTagPrefix: "dialer-queue-", controlTag: "audit-control" };

export interface RepSummary {
  repId: string;
  name: string;
  active: boolean;
  /** False when the audit could not establish that its searches would find anything. */
  verified: boolean;
  queueSize: number;
  errors: number;
  warnings: number;
}

export interface AuditReport {
  /** `unverified` wins over `findings`: the findings are real, but the list may be incomplete. */
  status: "clean" | "findings" | "unverified";
  /** Whether the control search found its contact. */
  controlled: boolean;
  reps: RepSummary[];
  findings: Finding[];
}

/** Pages by cursor until a page is empty or has none; a short page is not the last one. */
async function searchAll(port: AuditPort, filter: SearchFilter): Promise<Contact[]> {
  const found = new Map<string, Contact>();
  let cursor: unknown[] | undefined;
  let previous = "";
  for (;;) {
    const page = await port.searchContacts(filter, cursor);
    for (const contact of page.contacts) found.set(contact.id, contact);
    if (!page.contacts.length || !page.next) break;
    const key = JSON.stringify(page.next);
    if (key === previous) throw new Error(`search cursor did not advance: ${key}`);
    previous = key;
    cursor = page.next;
  }
  return [...found.values()];
}

/**
 * Audits every rep's queue without writing anything.
 *
 * An empty result is only "clean" if the audit could have found something: a queue
 * tag that does not exist in the location, or a workflow name that resolves to
 * nothing, makes the search meaningless, so that rep is reported as unverified.
 * Zero found by a query that could not have matched is not zero contamination.
 */
export async function audit(port: AuditPort, reps: Rep[], options: AuditOptions = DEFAULT_OPTIONS): Promise<AuditReport> {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  let controlled = false;
  if (!options.controlTag) {
    add({ check: "control", severity: "WARN", repId: "*", message: "no control tag configured: empty results cannot be told apart from a broken search" });
  } else if ((await searchAll(port, { tag: options.controlTag })).length === 0) {
    add({ check: "control", severity: "ERROR", repId: "*", message: `the control search for "${options.controlTag}" found nobody: the search is broken, so no empty queue below proves anything` });
  } else {
    controlled = true;
  }

  const tags = new Set(await port.listTags());
  const workflows = await port.listWorkflows();
  const byUser = new Map(reps.map((r) => [r.ghlUserId, r]));
  const summaries: RepSummary[] = [];

  for (const rep of reps) {
    let verified = true;

    // Positive controls: the things that must exist for the searches to mean anything.
    if (!tags.has(rep.queueTag)) {
      verified = false;
      add({ check: "control", severity: "ERROR", repId: rep.id, message: `queue tag "${rep.queueTag}" does not exist in the location: an empty search proves nothing` });
    }
    const named = workflows.filter((w) => w.name === rep.workflowName);
    if (named.length === 0) {
      verified = false;
      add({ check: "workflow", severity: "ERROR", repId: rep.id, message: `no workflow named "${rep.workflowName}"` });
    } else if (named.length > 1) {
      add({ check: "workflow", severity: "ERROR", repId: rep.id, message: `${named.length} workflows are named "${rep.workflowName}" (${named.map((w) => `${w.id} ${w.status}`).join(", ")}): which one feeds the queue is a guess` });
    } else if (rep.active && named[0]!.status !== "published") {
      add({ check: "workflow", severity: "WARN", repId: rep.id, message: `"${rep.workflowName}" is ${named[0]!.status}: tagged contacts never reach the call queue` });
    } else if (!rep.active && named[0]!.status === "published") {
      add({ check: "offboarding", severity: "WARN", repId: rep.id, message: `inactive rep's workflow "${rep.workflowName}" is still published` });
    }

    const queue = verified ? await searchAll(port, { tag: rep.queueTag }) : [];
    if (!rep.active && queue.length) {
      add({ check: "offboarding", severity: "ERROR", repId: rep.id, message: `inactive rep still has ${queue.length} contacts tagged "${rep.queueTag}"` });
    }

    // An inactive rep's queue is one offboarding finding, not one finding per contact.
    for (const contact of rep.active ? queue : []) {
      const owner = contact.assignedTo ? byUser.get(contact.assignedTo) : undefined;
      if (!contact.assignedTo) {
        add({ check: "no-owner", severity: "WARN", repId: rep.id, contactId: contact.id, message: "queued with no owner: invisible to a rep restricted to assigned contacts" });
      } else if (owner && !owner.active) {
        add({ check: "inactive-owner", severity: "ERROR", repId: rep.id, contactId: contact.id, message: `owned by ${owner.name}, who is no longer active` });
      } else if (contact.assignedTo !== rep.ghlUserId) {
        add({ check: "wrong-owner", severity: "ERROR", repId: rep.id, contactId: contact.id, message: `in ${rep.name}'s queue but owned by ${owner?.name ?? `unknown user ${contact.assignedTo}`}` });
      }
      if (contact.clientKey && contact.clientKey !== rep.clientKey) {
        add({ check: "other-client", severity: "ERROR", repId: rep.id, contactId: contact.id, message: `a ${contact.clientKey} lead in a queue dialing for ${rep.clientKey}` });
      }
      const queueTags = contact.tags.filter((t) => t.startsWith(options.queueTagPrefix));
      if (queueTags.length > 1 && queueTags[0] === rep.queueTag) {
        // Reported once, from the first queue tag, instead of once per queue.
        add({ check: "multiple-queues", severity: "ERROR", repId: rep.id, contactId: contact.id, message: `in ${queueTags.length} queues at once: ${queueTags.join(", ")}` });
      }
    }

    if (rep.active && verified) {
      const owned = await searchAll(port, { assignedTo: rep.ghlUserId });
      for (const contact of owned) {
        const inAQueue = contact.tags.some((t) => t.startsWith(options.queueTagPrefix));
        const isProtected = contact.tags.some((t) => options.protectedTags.includes(t));
        if (!inAQueue && !isProtected) {
          add({ check: "possible-ghost", severity: "WARN", repId: rep.id, contactId: contact.id, message: "owned with no queue tag: if it is still enrolled, it is in the call queue and no tag search will find it" });
        }
      }
    }

    const mine = findings.filter((f) => f.repId === rep.id);
    summaries.push({
      repId: rep.id,
      name: rep.name,
      active: rep.active,
      verified,
      queueSize: queue.length,
      errors: mine.filter((f) => f.severity === "ERROR").length,
      warnings: mine.filter((f) => f.severity === "WARN").length,
    });
  }

  if (!controlled) for (const summary of summaries) summary.verified = false;
  const status = summaries.some((s) => !s.verified) ? "unverified" : findings.length ? "findings" : "clean";
  return { status, controlled, reps: summaries, findings };
}
