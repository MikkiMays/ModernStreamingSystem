---
name: cord-web-client
description: "Cord React/Vite web client: TypeScript, Base UI, accessibility and client-side performance."
---

# cord-web-client

Read web/package.json and the existing design conventions. This is Vite, not Next.js: do not introduce Next server APIs. Preserve media track ownership, React effect cleanup, server-scoped state and session recovery during calls. Test keyboard/focus, dark and light themes, Cyrillic text, narrow mobile layouts, network failures and permission-denied states. Use the existing Base UI and query patterns. Reproduce browser bugs before changing code and check console and network evidence. Respect React Compiler; do not add memoization without a reason.
