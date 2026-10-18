---
name: cord-contracts
description: "Cord API and WebSocket contract changes: schemas, generated clients and compatibility."
---

# cord-contracts

Read contracts/, the API-generation script, the WebSocket schemas and both consumers. Review authorization, error shapes, ACKs, sequence numbers, replay and full-snapshot transitions, and idempotency. Add a compatibility matrix for old and new client and server wherever a wire change occurs. Regenerate only through the existing project command and inspect the generated diff. Update contract tests and docs alongside the code. Never hand-edit generated code to hide a schema mismatch.
