# Podcast Outreach agent

Takes in podcast prospects, screens and de-duplicates them, composes pitch
drafts, and files each one for human approval.

Status: **workflow implemented**. The full pipeline runs end to end against
in-memory adapters. No external provider is wired up, and nothing is ever sent
without a human decision.

## The workflow

```
  ┌─ inline targets ─┐
  │                  ├──▶ 1. intake ──▶ 2. screening ──▶ 3. rate check
  └─ ProspectSource ─┘         │              │                │
     (DataSourceConnector)     │              │                │
                          intake-invalid   skipped         rate-limited
                                                                │
                                                                ▼
                                     6. approval queue ◀── 5. compose ── 4. dedupe
                                          (pending)         (composer      (run +
                                              │              port)         ledger)
                                              ▼
                                    ── human decides ──   ← operator side
                                              │
                                              ▼
                                     ApprovalDispatcher ──▶ connector.send
```

| Stage | What happens | Lives in |
| --- | --- | --- |
| 1. Intake | Inline targets and/or records pulled from a `ProspectSourceConnector`, normalised into `PodcastTarget`. Unusable records become `intake-invalid` skips. | [intake.ts](src/intake.ts) |
| 2. Screening | Contact email present, syntactically valid, and not on the campaign suppression list. | [screening.ts](src/screening.ts) |
| 3. Rate check | `rateLimiter.peek` before composing, so we don't pay for a draft the guardrail is about to refuse. | [workflow.ts](src/workflow.ts) |
| 4. Dedupe | Within the run (id + normalised email) and across runs via the `OutreachLedger`. | [screening.ts](src/screening.ts), [ledger.ts](src/ledger.ts) |
| 5. Compose | The existing `OutreachComposer` port. Returning `null` is a skip, not an error. | [composer.ts](src/composer.ts) |
| 6. Submit | `context.outbound.submit(intent)`. The guardrail chain runs, then the item is queued `pending` (or stored `blocked`). | [workflow.ts](src/workflow.ts) |

Stages are ordered cheapest-first: the ledger is only read for prospects that
passed every local check, and the composer is only called for prospects that
passed the ledger *and* have rate-limit budget.

## Runtime boundary

What this agent does **not** do:

- **Never sends an email or message.** It can only create approval items. The
  send path requires an `ApprovalToken` it has no way to obtain, and its
  connector reader will not resolve an outbound connector at all — both are
  asserted in [test/podcast-outreach.test.ts](test/podcast-outreach.test.ts).
- **Never resolves or dispatches an approval item.** That is operator-side, via
  `ApprovalDispatcher`.
- **Never researches or scores podcasts itself.** Prospects arrive from input or
  a read-only source connector.
- **Never bypasses or reconfigures the guardrail chain** it is given. The
  rate-limit pre-check *peeks* and spends nothing; `rateLimitGuardrail` remains
  the only thing that consumes budget.
- **Never writes to the ledger for a prospect it did not queue.** A blocked or
  declined prospect stays eligible for a later run.
- **Never reads or writes anything in `timerich-brain`.**

The last thing `runPodcastOutreachWorkflow` touches is
`context.outbound.submit(intent)`.

## Inputs

```ts
interface PodcastOutreachInput {
  campaignId: string;                  // required, non-empty
  maxOutreachPerRun: number;           // positive integer; ceiling on approval items
  targets?: readonly PodcastTarget[];  // prospects supplied directly
  intake?: {                           // prospects pulled from a source connector
    connectorId: string;
    query: { campaignId: string; limit?: number };
  };
  suppress?: readonly string[];        // do-not-contact addresses or domains
}
```

At least one of `targets` / `intake` is required. Invalid input throws
`ValidationError` before the outbound gateway is touched.

`PodcastTarget` needs `id` and `showName`; `contactEmail`, `hostName`,
`website` and `relevanceNotes` are optional. Intake accepts snake_case and
common provider aliases (`show_name`, `email`, `notes`, …).

## Outputs

```ts
interface PodcastOutreachOutput {
  campaignId: string;
  intake: { received: number; accepted: number; rejected: number };
  evaluated: number;
  queued: readonly QueuedOutreach[];    // awaiting a human decision
  skipped: readonly SkippedTarget[];
  skippedByReason: Readonly<Partial<Record<SkipReason, number>>>;
}
```

`AgentRunResult` adds `runId`, `startedAt`, `finishedAt`, and `approvalIds` —
every approval item created, blocked ones included.

### Skip reasons

| Reason | Meaning |
| --- | --- |
| `intake-invalid` | Source record had no usable id or show name. |
| `missing-contact-email` | No contactable address. |
| `invalid-contact-email` | Address failed the syntax gate. |
| `suppressed` | On the campaign do-not-contact list. |
| `duplicate-target` | Same id or email already handled this run. |
| `already-contacted` | Queued in an earlier run, per the outreach ledger. |
| `run-limit-reached` | `maxOutreachPerRun` already satisfied. |
| `rate-limited` | Outreach budget exhausted; no draft was composed. |
| `composer-declined` | The composer returned `null`. |
| `guardrail-blocked` | Guardrails denied the intent; item stored as `blocked`. |

A skip is an outcome, not a failure. The run completes and reports it.

## Ports and adapters

Every external dependency is an interface with a safe in-memory implementation,
so the whole workflow runs with no network and no credential.

| Port | Shipped adapter | Notes |
| --- | --- | --- |
| `ProspectSourceConnector` | `InMemoryProspectSource` | Alias for the shared `DataSourceConnector<ProspectQuery, RawProspect>`. Read-only, so no approval boundary applies. |
| `OutreachComposer` | `notImplementedComposer` (default), `templateOutreachComposer` | The template composer invents no copy — wording comes from the caller's template. |
| `OutreachLedger` | `InMemoryOutreachLedger` | Cross-run contact history. **In-memory means it forgets on restart**; production needs a durable one. |

Secrets are referenced by name only (`EMAIL_PROVIDER_API_KEY`,
`PODCAST_PROSPECT_SOURCE_API_KEY`) via `SecretRef` on the manifest. No values
appear anywhere in this package.

## Wiring it up

`createPodcastOutreachPolicy` returns the guardrail chain and the rate limiter
as one object, because the workflow's `peek` and the guardrail's `consume` must
share a limiter instance to be meaningful:

```ts
const policy = createPodcastOutreachPolicy({ maxOutreachPerInterval: 25 });

const { context, queue } = createAgentRuntime(PODCAST_OUTREACH_AGENT_ID, {
  config: loadRuntimeConfig(),
  secrets: new EnvSecretProvider(),
  connectors: registry.asReader(),
  approvalStore: new InMemoryApprovalStore(),
  guardrails: policy.guardrails,
  rateLimiter: policy.rateLimiter,
});

const agent = new PodcastOutreachAgent({
  composer: templateOutreachComposer(campaignTemplate),
  ledger: outreachLedger,
});

const result = await agent.run(input, context);
// result.output.queued holds approval ids. Nothing has been sent.
```

## Not implemented yet

- Any real email provider or prospect provider connector.
- Real pitch copy — the template is caller-supplied by design.
- Reply handling, follow-up sequencing, and booking.
- Address verification (would be an `EnrichmentConnector`, not a syntax check).
- A durable `OutreachLedger`.

## Open questions for review

1. **Ledger scope is global, not per-campaign.** A prospect queued under one
   campaign is skipped by every later campaign. That is the conservative
   choice; if campaigns should be able to re-approach a host, this needs a
   scope flag.
2. **The ledger records at queue time, not send time.** A draft the reviewer
   later rejects still suppresses that prospect from future runs. Safer, but it
   means a rejection is effectively permanent until someone clears the entry.
3. **Rate-limit bucket is per agent, not per campaign or per domain.** Two
   campaigns running concurrently share one budget.
4. **Email validation is a syntax gate only.** Real deliverability checking is a
   separate enrichment step.

## Tests

```bash
npx vitest run agents/podcast-outreach
```

- [test/intake.test.ts](test/intake.test.ts) — normalisation, aliases, rejects, source scoping.
- [test/screening.test.ts](test/screening.test.ts) — email rules, suppression, dedupe ordering, ledger.
- [test/workflow.test.ts](test/workflow.test.ts) — every stage, plus rate limiting and reporting.
- [test/podcast-outreach.test.ts](test/podcast-outreach.test.ts) — manifest, composer, and the safety boundary end to end.
