# @timerich/shared

Runtime infrastructure every Time Rich agent builds on. Agents depend on the
interfaces here, not on concrete providers.

Import from the package entry point only:

```ts
import { createAgentRuntime, GuardrailChain } from '@timerich/shared';
```

Deep imports are blocked by the package `exports` map. That is not a style
preference — it is what keeps `mintApprovalToken` out of reach of agent code.
Together with `restrictOutboundAccess`, which hides outbound connectors from an
agent's `AgentContext`, it makes the approval boundary enforceable at compile
time. See the root
[README](../../README.md) for how the boundary works.

## Modules

| Folder | What it provides |
| --- | --- |
| `core/` | `TimeRichError` taxonomy, `Clock`, `IdGenerator`, and their test doubles. |
| `logging/` | `Logger`/`LogSink` contracts, `createLogger`, sinks, and deep field redaction. |
| `auth/` | `SecretRef`, `SecretProvider`, and `loadRuntimeConfig`. |
| `connectors/` | Connector interfaces, `ConnectorRegistry`/`ConnectorReader`, and `restrictOutboundAccess`. |
| `guardrails/` | `Guardrail`, `GuardrailChain`, `RateLimiter`, and built-in policies. |
| `approval-queue/` | `ApprovalToken`, `ApprovalQueue`, `OutboundGateway`, `ApprovalDispatcher`, `ApprovalStore`. |
| `agent/` | `Agent`, `AgentManifest`, `AgentContext`, and `createAgentRuntime`. |

## Conventions

- **Nothing reads ambient state implicitly.** `Clock`, `IdGenerator`,
  `SecretProvider` and env sources are all parameters with sensible defaults.
- **Secrets are referenced, never carried.** `SecretRef` holds a name. Errors
  name the missing secret; they never print a value.
- **Logs are redacted at the logger**, before the sink, so a secret passed by
  accident in `fields` cannot leak. Circular structures are broken, not thrown.
- **Guardrails fail closed.** A guardrail that throws becomes a denial.
- **Every port has an in-memory double** (`InMemoryApprovalStore`,
  `InMemorySecretProvider`, `MemoryLogSink`, `FixedClock`,
  `SequentialIdGenerator`), so tests need no network and no real time.

## Extending it

Adding a provider means implementing an interface, not editing shared code:

- A new outbound channel implements `OutboundConnector` — note that `send`
  requires an `ApprovalToken`.
- A durable approval store implements the four `ApprovalStore` methods.
- A new policy implements `Guardrail` and is added to the chain at the
  composition root, never inside an agent.
- A distributed rate limiter implements `RateLimiter`.
