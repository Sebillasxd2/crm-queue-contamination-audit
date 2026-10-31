# crm-queue-contamination-audit

A read-only audit of per-rep dialer queues in GoHighLevel: contacts owned by the wrong rep or by a rep who left, another client's leads, contacts in two queues, possible ghosts, ambiguous workflows. It refuses to call a queue clean unless a control proves its searches work.

## The problem

Each rep dials from a queue: contacts carrying the rep's queue tag, assigned to the rep, fed into the rep's call workflow. Over weeks of loads, reassignments and people leaving, queues drift: a departed rep's contacts sit in a colleague's queue, a lead loaded for one client lands in a rep dialing for another, a contact ends up in two queues. None of it raises an error, and the rep just sees the wrong people.

## The traps nobody documents

1. **Zero is not clean until something proves the search works.** A search with the wrong filter shape, a renamed field or a misspelled tag returns nothing, the same nothing a clean queue returns. The audit pairs each search shape with its own control. The tag search: a tag kept on at least one known contact must be found, otherwise the whole audit is `unverified`. The owner search, which the ghost check rests on: every queued contact the tag search already showed as assigned to a rep must come back when searching by that rep, otherwise that rep is `unverified`. A rep whose queue tag does not exist in the location is `unverified` too, and so is an empty roster, which reads nothing. Without a control tag configured, the audit does not report `clean`. Tests break each search shape on purpose and check that the result is `unverified`, not clean.
2. **Tag and owner can disagree.** A rep restricted to assigned contacts only sees contacts assigned to them. A contact tagged for one rep but owned by another, or by nobody, is in one rep's workflow and on someone else's screen, or nobody's.
3. **People leave; their contacts stay.** A departed rep's contacts keep their owner and tag, show up in colleagues' queues, and the departed rep's workflow stays published. The audit flags contacts owned by an inactive rep, an inactive rep who still has a queue, and a still-published workflow.
4. **Leads cross clients.** When a rep moves to another client, or two queues share a load, a lead loaded for one client ends up in a queue dialing for another. The audit compares the client key stored on the contact with the rep's current client.
5. **A contact can be in two queues.** Two queue tags on one contact put it in two reps' workflows.
6. **Ghosts are invisible to a tag search.** Removing a tag does not take a contact out of a workflow. The public API does not expose enrollment, so the audit reports owned contacts with no queue tag as *possible* ghosts, for a person to check in the call queue.
7. **Workflow names are not unique.** A rep's workflow is looked up by name; two workflows with that name is an error, not a guess, and a draft one is flagged because tagged contacts never reach the call queue.

## The solution

`audit()` in [src/audit.ts](src/audit.ts), against a three-method read-only port ([src/model.ts](src/model.ts)): list tags, list workflows, search contacts by tag or owner. Searches page by cursor until a page comes back empty, never stopping on page length, and stop with an error if the cursor repeats.

| check | severity | means |
|---|---|---|
| `control` | ERROR / WARN | the control search found nobody, the owner search missed contacts it should return or had nothing to be checked against, a queue tag does not exist, the roster is empty, or no control is configured |
| `workflow` | ERROR / WARN | the rep's workflow is missing, ambiguous, or not published |
| `inactive-owner` | ERROR | a queued contact is owned by a rep who left |
| `wrong-owner` | ERROR | a queued contact is owned by another rep or an unknown user |
| `other-client` | ERROR | a lead loaded for another client |
| `multiple-queues` | ERROR | a contact with more than one queue tag, reported once per contact |
| `offboarding` | ERROR / WARN | an inactive rep still has a queue, or a published workflow |
| `no-owner` | WARN | queued with no owner: invisible to a restricted rep |
| `possible-ghost` | WARN | owned, no queue tag, not protected (`booked`, `customer`) |

Status: `clean`, `findings`, or `unverified`. `unverified` wins over `findings`: what was found is real, but the list may be incomplete. A failed control or an empty roster is always `unverified`.

## Run it

Needs Node 22.18 or newer, which runs TypeScript directly. No build step and no runtime dependencies.

```sh
npm test                       # the whole suite, offline
npm run demo                   # audit the seeded fixture location in memory
node src/cli.ts --json         # the full report as JSON
GHL_API_TOKEN=... GHL_LOCATION_ID=... CLIENT_FIELD_ID=... node src/cli.ts --live --reps reps.json
```

`npm install` is only needed for `npm run typecheck`. Exit codes: `0` clean, `1` findings, `2` unverified or bad input. `--live` reads only: the HTTP adapter issues GETs and the POST that contact search requires, and a test checks that nothing else goes out.

```
queue audit: unverified

rep             active  verified   queue  errors  warns
Avery Sample    yes     yes           10       4      2
Jordan Sample   yes     yes            6       4      1
Casey Sample    no      yes            3       1      1
Riley Sample    yes     NO             0       2      0

rep_avery
  ERROR inactive-owner  ct_a06  owned by Casey Sample, who is no longer active
  ERROR other-client    ct_a08  a prairie lead in a queue dialing for riverbend
  ERROR multiple-queues ct_a09  in 2 queues at once: dialer-queue-avery, dialer-queue-jordan
  WARN  no-owner        ct_a10  queued with no owner: invisible to a rep restricted to assigned contacts
  ...
rep_riley
  ERROR control         queue tag "dialer-queue-riley" does not exist in the location: an empty search proves nothing
  ERROR workflow        no workflow named "Dialer Queue - Riley"
```

The fixture ([fixtures/location.json](fixtures/location.json), [fixtures/reps.json](fixtures/reps.json)) is synthetic and seeds one case of every check, plus a control contact.

## Known gaps

- **Enrollment.** Today ghosts are reported as possible: the public API does not say which workflow a contact is enrolled in. To confirm in the call queue itself.
- **Client key.** Today it is read from a contact custom field (`CLIENT_FIELD_ID`) that the loader fills. To confirm: that your loads write it; contacts without it are not checked for `other-client`.
- **Search filter shape.** Today the adapter sends `{ field: "tags", operator: "contains", value }` and `{ field: "assignedTo", operator: "eq", value }`, as I read the public Search Contacts docs. The control tag tells you if the tag shape is wrong for your account, and the owner check tells you if the owner shape is.
- **Roster.** Today who is active comes from the local `reps` table, not from the CRM's user list. To confirm it is kept current when people leave.

---

*Pattern extracted from work I did on an outbound sales operation; the code here is written from scratch with synthetic data.*
