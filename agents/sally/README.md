# Sally agent

**Placeholder.** Package `@timerich/agent-sally`.

This folder exists so the agent has a home in the monorepo and a manifest that
already commits to the approval boundary. Responsibilities, inputs, outputs,
connectors and outbound channels are defined in `timerich-brain` and land here
when that spec is agreed.

What is fixed already, via `sallyManifest`:

- Outbound work is queued for human approval, never sent directly.
- The guardrail chain given to the agent is not bypassed or reconfigured.
- Nothing in `timerich-brain` is read or written.

See the root [README](../../README.md) for the shared infrastructure and the
approval boundary, and [podcast-outreach](../podcast-outreach/README.md) for the
shape a fully scaffolded agent takes.
