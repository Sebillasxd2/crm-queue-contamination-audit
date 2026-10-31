import type { AuditPort, Contact, ContactPage, SearchFilter, Workflow } from "./model.ts";

export interface HttpPortOptions {
  token: string;
  locationId: string;
  /** Contact custom field id that holds the client key the lead was loaded for. */
  clientFieldId?: string;
  baseUrl?: string;
  version?: string;
  pageLimit?: number;
  fetch?: typeof fetch;
}

/**
 * `AuditPort` over the public API v2. Read only: it issues GETs, plus the POST that
 * contact search requires, and nothing else.
 */
export function createHttpPort(options: HttpPortOptions): AuditPort {
  const base = options.baseUrl ?? "https://services.leadconnectorhq.com";
  const doFetch = options.fetch ?? fetch;
  const loc = encodeURIComponent(options.locationId);

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        Version: options.version ?? "2021-07-28",
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    async listTags() {
      const res = await request<{ tags?: { name: string }[] }>("GET", `/locations/${loc}/tags`);
      return (res.tags ?? []).map((t) => t.name);
    },
    async listWorkflows() {
      const res = await request<{ workflows?: Workflow[] }>("GET", `/workflows/?locationId=${loc}`);
      return res.workflows ?? [];
    },
    async searchContacts(filter: SearchFilter, searchAfter?: unknown[]): Promise<ContactPage> {
      const condition =
        "tag" in filter
          ? { field: "tags", operator: "contains", value: filter.tag }
          : { field: "assignedTo", operator: "eq", value: filter.assignedTo };
      type Raw = { id: string; tags?: string[]; assignedTo?: string | null; customFields?: { id: string; value: unknown }[]; searchAfter?: unknown[] };
      const res = await request<{ contacts?: Raw[] }>("POST", "/contacts/search", {
        locationId: options.locationId,
        pageLimit: options.pageLimit ?? 100,
        filters: [condition],
        ...(searchAfter ? { searchAfter } : {}),
      });
      const raw = res.contacts ?? [];
      const contacts: Contact[] = raw.map((c) => {
        const client = options.clientFieldId ? c.customFields?.find((f) => f.id === options.clientFieldId)?.value : undefined;
        return { id: c.id, tags: c.tags ?? [], assignedTo: c.assignedTo ?? null, ...(typeof client === "string" ? { clientKey: client } : {}) };
      });
      const cursor = raw.at(-1)?.searchAfter;
      return cursor ? { contacts, next: cursor } : { contacts };
    },
  };
}
