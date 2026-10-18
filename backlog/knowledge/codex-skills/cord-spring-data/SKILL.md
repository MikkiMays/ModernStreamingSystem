---
name: cord-spring-data
description: "Cord/ModernStreamingSystem Java and Spring backend: JDBC transactions, PostgreSQL, Redis, Flyway and concurrent state."
---

# cord-spring-data

Read pom.xml and server/pom.xml first and use the actual Java/Spring versions. Inspect JDBC repositories rather than assuming Hibernate/JPA. Trace transaction boundaries, locking, atomic reservations, Redis expiry and idempotency. Keep Flyway migrations additive and never rewrite an applied migration. Review H2-versus-PostgreSQL differences; require PostgreSQL/Testcontainers evidence for database-specific behavior. Treat EXPLAIN ANALYZE as query execution; do not run writes or migrations against production.
