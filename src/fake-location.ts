import type { AuditPort, Contact, ContactPage, SearchFilter, Workflow } from "./model.ts";

export interface LocationData {
  tags: string[];
  workflows: Workflow[];
  contacts: Contact[];
}

/**
 * In-memory location for the audit. Search pages by cursor and can serve pages
 * shorter than a full page. `brokenSearch` makes searches come back empty, the way
 * a wrong filter shape or a renamed field does on a real API: `true` breaks both
 * shapes, `"tag"` or `"owner"` only one, since the two are different field and
 * operator pairs and one can be wrong while the other works.
 */
export class FakeLocation implements AuditPort {
  brokenSearch: boolean | "tag" | "owner" = false;
  readonly searches: SearchFilter[] = [];
  private readonly data: LocationData;
  private readonly pageSize: number;

  constructor(data: LocationData, pageSize = 3) {
    this.data = structuredClone(data);
    this.pageSize = pageSize;
  }

  async listTags(): Promise<string[]> {
    return [...this.data.tags];
  }

  async listWorkflows(): Promise<Workflow[]> {
    return structuredClone(this.data.workflows);
  }

  async searchContacts(filter: SearchFilter, searchAfter?: unknown[]): Promise<ContactPage> {
    this.searches.push(filter);
    if (this.brokenSearch === true || this.brokenSearch === ("tag" in filter ? "tag" : "owner")) return { contacts: [] };
    const after = typeof searchAfter?.[0] === "string" ? searchAfter[0] : "";
    const matches = this.data.contacts
      .filter((c) => ("tag" in filter ? c.tags.includes(filter.tag) : c.assignedTo === filter.assignedTo))
      .filter((c) => c.id > after)
      .sort((a, b) => a.id.localeCompare(b.id));
    const contacts = matches.slice(0, this.pageSize).map((c) => structuredClone(c));
    const last = contacts.at(-1);
    // Like many real APIs, every non-empty page carries a cursor, the last one included.
    return last ? { contacts, next: [last.id] } : { contacts };
  }
}
