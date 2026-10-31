/** A row of the local `reps` table: who should own which queue. */
export interface Rep {
  id: string;
  name: string;
  ghlUserId: string;
  /** The client this rep currently dials for. */
  clientKey: string;
  queueTag: string;
  /** Resolved by name, because that is how people refer to it. */
  workflowName: string;
  active: boolean;
}

export interface Contact {
  id: string;
  tags: string[];
  assignedTo?: string | null;
  /** Which client the lead was loaded for, from a contact custom field. */
  clientKey?: string;
}

export interface Workflow {
  id: string;
  name: string;
  status: string;
}

export type SearchFilter = { tag: string } | { assignedTo: string };

export interface ContactPage {
  contacts: Contact[];
  next?: unknown[];
}

/** Read-only by construction: there is no method that writes. */
export interface AuditPort {
  listTags(): Promise<string[]>;
  listWorkflows(): Promise<Workflow[]>;
  searchContacts(filter: SearchFilter, searchAfter?: unknown[]): Promise<ContactPage>;
}

export type Severity = "ERROR" | "WARN" | "INFO";

export interface Finding {
  check: string;
  severity: Severity;
  repId: string;
  contactId?: string;
  message: string;
}
