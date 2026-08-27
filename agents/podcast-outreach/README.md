# Podcast Outreach agent

Turns researched podcast targets into reviewable outreach drafts and files them
for human approval.

Status: **scaffolded**. The run pipeline, screening rules, and approval
submission are implemented and tested. The outreach integrations — drafting and
sending — are not.

## Responsibilities

1. Accept a campaign and a list of researched podcast targets.
2. Screen targets for contactability and de-duplicate within a run.
3. Ask the composer port for a draft pitch per eligible target.
4. Submit each draft to the approval queue with a stated reason for the reviewer.
5. Report exactly what was queued and what was skipped, and why.

## Runtime boundary

What this agent does **not** do:

- **Never sends an email or message.** It can only create approval items. The
  send path requires an `ApprovalToken` it has no way to obtain, and its
  connector reader will not resolve an outbound connector at all.
- **Never resolves or dispatches an approval item.** That is operator-side, via
  `ApprovalDispatcher`.
- **Never sources or researches podcasts itself.** Targets arrive as input.
- **Never bypasses or reconfigures the guardrail chain** it is given.
- **Never reads or writes anything in `timerich-brain`.**

The last thing `run` touches is `context.outbound.submit(intent)`. Everything
after that is a human decision followed by operator-side dispatch.

## Inputs

```ts
interface PodcastOutreachInput {
  campaignId: string;              // required, non-empty
  targets: readonly PodcastTarget[];
  maxOutreachPerRun: number;       // positive integer; hard ceiling on approval items
}

interface PodcastTarget {
  id: string;
  showName: string;
  hostName?: string;
  contactEmail?: string;           // absent means the target is skipped
  website?: string;
  relevanceNotes?: string;         // why research believes this show is a fit
}
```

Invalid input throws `ValidationError` before the outbound gateway is touched.

## Outputs

```ts
interface PodcastOutreachOutput {
  campaignId: string;
  evaluated: number;                        // targets looked at, including skips
  queued: readonly QueuedOutreach[];        // drafts now awaiting a human decision
  skipped: readonly SkippedTarget[];
}
```

`AgentRunResult` additionally carries `runId`, `startedAt`, `finishedAt`, and
`approvalIds` — every approval item the run created, including blocked ones.

### Skip reasons

| Reason | Meaning |
| --- | --- |
| `missing-contact-email` | No contactable address on the target. |
| `duplicate-target` | Same target id or email already handled this run. |
| `run-limit-reached` | `maxOutreachPerRun` already satisfied. |
| `composer-declined` | The composer returned `null` for this target. |
| `guardrail-blocked` | Guardrails denied the intent; item stored as `blocked`. |

A skip is an outcome, not a failure. The run completes and reports it.

## Ports

`OutreachComposer` turns a target into a draft:

```ts
interface OutreachComposer {
  compose(target: PodcastTarget, context: OutreachComposeContext):
    Promise<ComposedOutreach | null>;   // null means "decline to pitch this one"
}
```

The default is `notImplementedComposer()`, which throws `NotImplementedError`.
That is deliberate: the scaffold fails loudly rather than shipping a silent
placeholder pitch. Inject a real composer when one exists.

The outbound connector is named by id (`email.primary`) on every intent and
resolved by the dispatcher at send time. The agent never holds the connector.

## Not implemented yet

- Pitch composition.
- Any real email provider connector.
- Reply handling, follow-up sequencing, and booking.
- Sourcing or enriching podcast targets.

## Tests

```bash
npx vitest run agents/podcast-outreach
```

The suite covers screening, de-duplication (by id and by normalised email), the
run limit, composer declines, guardrail denials, input validation, and an
end-to-end path asserting the connector is reached **only** after a human
approves.
