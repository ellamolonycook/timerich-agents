# timerich-agents

Runtime agent system for Time Rich. This repository holds the code that **runs**:
agents, shared infrastructure, connectors, secrets handling, scheduling hooks,
logging, rate limiting, and the approval-before-send guardrail.

Owner: Ella Molony Cook.

---

## Relationship to `timerich-brain`

These are two separate repositories with a deliberate split. Nothing in this
repository reads from, writes to, or duplicates `timerich-brain`.

| | `timerich-brain` | `timerich-agents` (this repo) |
| --- | --- | --- |
| Purpose | Knowledge, research, design specs, planning, decisions | Runtime execution |
| Contains | Strategy, agent specifications, positioning, research notes | Agents, connectors, guardrails, approval queue, logging |
| Changes when | A decision or spec changes | Runtime behaviour changes |
| Question it answers | *What should the agent do, and why?* | *How does the agent do it, safely?* |

The practical rule: if you are deciding **what** an agent should do, that
belongs in `timerich-brain`. If you are deciding **how** it executes and what
stops it from doing damage, it belongs here. A spec agreed in the brain lands
here as a manifest, a set of typed inputs and outputs, and tests.

---

## The approval boundary

This is the most important design constraint in the repository.

**No agent can send anything externally.** Not by policy or convention — the
type system prevents it.

```
agent ──▶ context.outbound.submit(intent)      ← the only outbound surface an agent has
              │
              ▼
        GuardrailChain.evaluate()               ← rate limits, completeness, future policy
              │
              ▼
        ApprovalQueue.submit()  ──▶  status: 'pending' (or 'blocked' if guardrails denied)
              │
              ▼
        ── human reviews and decides ──         ← operator side, not reachable from an agent
              │
              ▼
        ApprovalQueue.claimApproved()  ──▶ mints an ApprovalToken
              │
              ▼
        ApprovalDispatcher ──▶ connector.send(message, token)   ← requires the token
```

The guarantee rests on two independent layers, either of which alone stops a
send.

**Layer 1 — an agent cannot obtain an approval token.**

1. `OutboundConnector.send(message, approval: ApprovalToken)` requires a token.
2. `ApprovalToken` carries a brand keyed by a `unique symbol` with no runtime
   value. The only function that produces one is `mintApprovalToken`.
3. `mintApprovalToken` is **not exported** from `@timerich/shared`, and the
   package `exports` map blocks deep imports. An agent cannot reach it.
4. `ApprovalQueue.claimApproved` is the sole caller, and it throws unless the
   item is in status `approved` — meaning a named human recorded a decision.

**Layer 2 — an agent cannot obtain anything with a `send` method.**

5. `AgentContext.outbound` is an `OutboundGateway`: it has `submit` and no
   `send`.
6. `AgentContext.connectors` is an `AgentConnectorReader`, which has no
   `requireOutbound` and whose `get`/`require` throw for outbound connectors.
   `createAgentRuntime` applies this wrapper, so agents never see the
   unrestricted reader.

An agent that tries to send does not fail at runtime in production — it fails to
compile. TypeScript's branding is not proof against a deliberate
`as ApprovalToken` assertion, which is exactly why layer 2 exists: forging a
token gets you nothing, because there is no reachable connector to hand it to.
Subverting the boundary would take an explicit type assertion *and* a change to
the composition root, both of which are visible in review.

These properties are covered by tests in
`packages/shared/test/approval-boundary.test.ts`.

Supporting properties:

- Guardrails **fail closed**: a guardrail that throws is recorded as a denial.
- A guardrail-denied intent is stored as `blocked` rather than discarded, so a
  reviewer can see what the agent tried to do.
- Terminal states (`rejected`, `blocked`, `expired`, `dispatched`, `failed`)
  never transition again, so an item cannot be dispatched twice.
- Pending items expire after `TIMERICH_APPROVAL_TTL_MINUTES` and can no longer
  be approved.

---

## Layout

```
timerich-agents/
├── packages/
│   └── shared/                     @timerich/shared - infrastructure for every agent
│       ├── src/
│       │   ├── connectors/         Connector interfaces + registry
│       │   ├── auth/               Secret refs, secret providers, runtime config
│       │   ├── logging/            Structured logger, sinks, redaction
│       │   ├── guardrails/         Guardrail chain, rate limiting, built-in policies
│       │   ├── approval-queue/     Approval token, queue, gateway, dispatcher, store
│       │   ├── agent/              Agent contract + composition root helper
│       │   └── core/               Errors, clock, id generation
│       └── test/
├── agents/
│   ├── podcast-outreach/           Workflow: intake, screening, ledger,
│   │                               policy, composer, approval submission
│   ├── outbound-data/              Placeholder manifest
│   ├── speaking-ops/               Placeholder manifest
│   └── sally/                      Placeholder manifest
├── package.json                    npm workspaces root
├── tsconfig.base.json              Strict compiler options
├── tsconfig.json                   Project-reference solution
├── tsconfig.test.json              Type checks test files against shared source
└── vitest.config.ts
```

### Shared infrastructure

Everything below is an interface first and an implementation second, so agents
depend on the contract and tests inject fakes.

| Area | Contract | Shipped implementations |
| --- | --- | --- |
| Connectors | `Connector`, `OutboundConnector`, `DataSourceConnector`, `EnrichmentConnector` | `ConnectorRegistry`, `ConnectorReader`, `restrictOutboundAccess` |
| Auth / config | `SecretRef`, `SecretProvider`, `RuntimeConfig` | `EnvSecretProvider`, `InMemorySecretProvider`, `loadRuntimeConfig` |
| Logging | `Logger`, `LogSink` | `createLogger`, `JsonConsoleSink`, `MemoryLogSink`, `NullLogSink`, `redact` |
| Rate limiting | `RateLimiter` | `TokenBucketRateLimiter`, `NoopRateLimiter` |
| Guardrails | `Guardrail` | `GuardrailChain`, `rateLimitGuardrail`, `outboundCompletenessGuardrail` |
| Approval | `ApprovalStore`, `OutboundGateway` | `ApprovalQueue`, `ApprovalGatedOutboundGateway`, `ApprovalDispatcher`, `InMemoryApprovalStore` |
| Agent contract | `Agent`, `AgentManifest`, `AgentContext` | `createAgentRuntime` |
| Core | `Clock`, `IdGenerator`, `TimeRichError` | `systemClock`, `FixedClock`, `uuidIdGenerator`, `SequentialIdGenerator` |

Design rules that keep it reusable:

- **Dependencies are explicit.** Time (`Clock`) and identity (`IdGenerator`)
  are injected, so a run is deterministic under test.
- **Agent-specific logic stays in the agent folder.** Shared code knows nothing
  about podcasts, speaking gigs, or Sally.
- **Side effects sit behind ports.** Every external call is an interface with an
  in-memory double, so no test needs a network.
- **Agents get narrowed views.** `AgentConnectorReader`, not
  `ConnectorRegistry`. `OutboundGateway`, not `ApprovalQueue`.

### The agents

| Agent | Status | Notes |
| --- | --- | --- |
| Podcast Outreach | Workflow implemented | Intake, screening, cross-run dedupe, rate limiting, composition port, approval submission. No provider integrations. See [agents/podcast-outreach/README.md](agents/podcast-outreach/README.md). |
| Outbound Data | Placeholder | Manifest only, pending spec. |
| Speaking Ops | Placeholder | Manifest only, pending spec. |
| Sally | Placeholder | Manifest only, pending spec. |

Every `AgentManifest` types `outbound.approvalRequired` as the literal `true`,
so no agent can declare itself exempt from review.

---

## What is deliberately not here yet

- No connector implementations. Instantly, ZeroBounce, Resend, WhatsApp and
  LinkedIn are named nowhere in the code, only as commented placeholders in
  `.env.example`. Podcast Outreach runs against in-memory adapters
  (`InMemoryProspectSource`, `InMemoryOutreachLedger`) that perform no I/O.
- No credentials. Secrets are referenced by name via `SecretRef` and resolved at
  runtime through a `SecretProvider`. Nothing is hardcoded.
- No pitch copy. The Podcast Outreach composer is a port whose default
  implementation throws `NotImplementedError`; the shipped
  `templateOutreachComposer` renders a caller-supplied template and invents
  nothing of its own.
- No scheduler. The agent contract is scheduler-agnostic on purpose.
- No durable approval store. `InMemoryApprovalStore` implements the four-method
  `ApprovalStore` port; a database-backed store drops in without touching agents.

---

## Getting started

```bash
npm install
npm run typecheck    # tsc project references + test files
npm test             # vitest
npm run check        # both
npm run build        # emit dist/ for every workspace
```

Copy `.env.example` to `.env` for local configuration. `.env` is gitignored;
`TIMERICH_DRY_RUN` defaults to `true` and unknown config values fail at startup
rather than silently defaulting.

Tests run against shared **source** via a Vitest alias, so a build is never a
prerequisite and results can never reflect a stale `dist/`.

---

## Wiring an agent

The composition root owns the registry, the guardrails, and the queue. The agent
receives a context that can queue but cannot send.

```ts
const registry = new ConnectorRegistry().register(emailConnector);

const { context, queue } = createAgentRuntime('podcast-outreach', {
  config: loadRuntimeConfig(),
  secrets: new EnvSecretProvider(),
  connectors: registry.asReader(),
  approvalStore: new InMemoryApprovalStore(),
  guardrails: new GuardrailChain([
    outboundCompletenessGuardrail(),
    rateLimitGuardrail({ limiter: new TokenBucketRateLimiter({ ... }) }),
  ]),
});

const result = await new PodcastOutreachAgent({ composer }).run(input, context);
// result.output.queued holds approval ids. Nothing has been sent.

// Operator side, after a human decides:
await queue.approve(approvalId, { decidedBy: 'ella' });
await new ApprovalDispatcher({ queue, connectors: registry.asReader(), logger }).dispatch(approvalId);
```

Note that `queue` is returned separately from `context`. Operator tooling needs
it; agents must not have it.
