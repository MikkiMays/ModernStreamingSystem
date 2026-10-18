---
name: cord-verification
description: "Cord verification: choose the real project checks and report evidence without overstating coverage."
---

# cord-verification

Read .github/workflows, scripts/, docs/verification.md and the package manifests. Choose checks from the files that changed. Start with a failing regression test when practical, then the targeted test, adjacent integration coverage, formatting and the build. Record each command and its exit code. Report checks that were not run, tools that are absent and environmental blockers separately from failures. Never label the whole system verified because unit tests passed.
