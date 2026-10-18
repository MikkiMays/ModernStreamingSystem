## Standing publication instruction

The user explicitly authorized this workflow on 2026-09-22: after task-related code or
configuration changes, keep both repositories' local and remote `main` branches current
and update the production deployment at `meet.nikg.tech`, including the Windows release
when its code changes. Complete the relevant checks and verify deployment health. Do not
stop with changes only in a worktree or request the same publication permission again.
Preserve unrelated work and production data. A later explicit user instruction can
override this standing workflow.

<!-- codex-toolkit:start -->
## Codex toolkit: skills, subagents and routing

`~/.codex/modern-toolkit/INVENTORY.md` lists every installed skill and subagent with its
real path. Do not load the catalog; pick 1-3 relevant skills, read their `SKILL.md`, act.
Use a skill proactively when its description matches the task; an explicit user scope wins.

Subagents live in `~/.codex/agents/` and are available in every project. Codex never
auto-spawns them. For a bounded edit, work directly. For a substantial cross-module task,
explicitly spawn 2-4 subagents with non-overlapping scopes, wait for them, and integrate
the results. Do not spawn agents merely because they are installed. If delegation is
unavailable, do the work sequentially and say so.

Skills that arrive from a plugin or pack are listed namespaced, as `pack:skill`
(`superpowers:writing-plans`, `static-analysis:semgrep`). Use the name exactly as listed.

Routing (skills first, then the subagents worth delegating to):
- Backend/data: `cord-spring-data`; `java-architect`, `spring-boot-engineer`,
  `python-pro`, `fastapi-developer`, `sql-pro`, `postgres-pro`, `database-optimizer`.
  Read the real data-access layer before assuming an ORM.
- UI: `vercel-react-best-practices`, `vercel-composition-patterns`,
  `web-design-guidelines`, `frontend-design`, `cord-web-client`; `react-specialist`,
  `ui-designer`, `accessibility-tester`, `anti-ui-slop-reviewer`.
- Debugging: `superpowers:systematic-debugging` first; reproduce before changing code.
  Then `debugger`, `error-detective`, `browser-debugger`.
- Planning: `superpowers:brainstorming` then `superpowers:writing-plans` /
  `superpowers:executing-plans` for multi-step work.
- Tests/completion: `superpowers:test-driven-development`,
  `superpowers:verification-before-completion`, `cord-verification`; `test-automator`,
  `qa-expert`, `reviewer`.
- Review: `superpowers:requesting-code-review`, `superpowers:receiving-code-review`,
  `differential-review:differential-review`, `second-opinion:second-opinion`.
- Security: `static-analysis:semgrep`, `static-analysis:codeql`, `sharp-edges:sharp-edges`,
  `audit-context-building:audit-context-building`, `variant-analysis:variant-analysis`,
  `supply-chain-risk-auditor:supply-chain-risk-auditor`, `security-threat-model`;
  `security-auditor`, `penetration-tester`. Separate confirmed vulnerabilities from
  hypotheses; do not turn an ordinary UI edit into a full audit.
- Browser work: `playwright`, `playwright-interactive`, `webapp-testing`, `screenshot`.
- CI/PR: `gh-fix-ci`, `gh-address-comments`; reuse the existing `gh` authentication.
- Infra: `cord-deployment-review`; `docker-expert`, `deployment-engineer`,
  `sre-engineer`, `network-engineer`, `incident-responder`.
- Media/WebRTC: `cord-media-reliability`; `websocket-engineer`, `network-engineer`.
- Uploads/retention: `cord-file-lifecycle`. Wire contracts: `cord-contracts`.
- Windows/.NET: `winui-app`, `aspnet-core`, `cord-windows-bridge`; `csharp-developer`,
  `dotnet-core-expert`, `powershell-7-expert`.
- Agents/MCP work: `mcp-builder`, `chatgpt-apps`; `mcp-developer`, `ai-engineer`,
  `llm-architect`, `prompt-engineer`.

Read the real manifests and repository docs before any version-specific claim. Use the
documentation MCP servers for public API questions, never to upload private source, logs,
tokens, environment files or identifiers; if they are unavailable, use primary web docs.
Some upstream skills reference Claude tool names or `~/.claude` paths: translate them to
the Codex equivalent and the real installed path. Do not invent tools that do not exist.
Preserve work in progress: no `reset --hard`, force push, production restart or deploy,
data cleanup, rewrite of an applied migration or weakening of permissions without
authorization. Never bypass browser media permissions, sandboxing or approval policies.
At completion, report changed files, the commands you actually ran with their results,
and the gaps that remain unverified.
<!-- codex-toolkit:end -->
