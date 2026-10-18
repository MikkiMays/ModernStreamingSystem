---
name: cord-deployment-review
description: "Cord deployment review: Docker Compose, Caddy, TURN/TLS, networking, health and release readiness."
---

# cord-deployment-review

Read compose.yaml, infra/ and docs/deployment.md. Separate localhost validation from the real VPS and network path. Review SNI routing, TCP/UDP exposure, forwarded origin, signaling authorization, TLS, healthchecks, resource limits, volumes, retention and rollback. Never print interpolated compose secrets. Static checks do not prove connectivity, capacity or reliability. Do not run setup.sh, restart services, open ports, prune Docker, publish releases or deploy without task-specific approval.
