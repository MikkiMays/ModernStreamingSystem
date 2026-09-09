# Cord on meet.nikg.tech — deployment record, 9 September 2026

## Scope and decision

Deploy the existing Cord web application and Windows installer on this server as a separate project in `/opt/meet`. New installs must connect to `https://meet.nikg.tech` without a local Java/Node server or manual server settings. Browser and desktop must join the same rooms and support camera, microphone, screen sharing, chat, files, admission and recovery.

Source snapshots: server/web `b01a9b69c263e3dc2e5db0f5dcd0cf99a62d65c4`; Windows `6dd05c50a703cc265d30d6f804914bc64b8968b1`. Both repositories live under `/opt/meet/` using their GitHub names. Private GitHub access is through the linked connector. Original file contents were verified against Git blob hashes. Local initial commits are imports, so they must not be force-pushed over upstream history.

Retain **LiveKit SFU and the shared WebRTC client** for Cord. The current Kiki/Klodi path serves remote observation: Windows FFmpeg hardware capture/encoding → SRT → MediaMTX → browser WHEP. Its documented GPU/RAM/GDI fallback and measured SRT unit correction are useful engineering evidence, but moving conference audio, camera, screen tracks and participant permissions onto that path would add a second integration without a measured gain. Cord already has the multi-participant model, ICE/TURN, independent control reconnect and shared browser/Windows behavior. Kiki and Klodi remain separately operated; no speculative transport rewrite is part of this deployment.

Reviewed: Kiki START-HERE, SERVER and streaming MEDIA-UDP sections; Klodi architecture, current streaming handoff and `Talk/Stage.cs`; Fleet architecture and STREAMING-REVIEW-2026-09-08; both Cord READMEs, deployment/cohost instructions, architecture, latency research, installer scripts and verification records. Prefer current code and this server's checks to old latency estimates.

Official references: [LiveKit VM deployment](https://docs.livekit.io/transport/self-hosting/vm/), [ports/firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/). SFU media travels outside the HTTPS proxy; the measured route and received frames are required to prove UDP or TURN behavior.

## Isolation and network

Compose project: `modern-streaming`. Separate PostgreSQL, Redis, upload and certificate volumes. Core and private file hooks bind loopback. The existing Kiki processes on host TCP 8090 and 8091 required **hooks 18090 and gateway 18091**; the generator now propagates these configurable ports through edge, gateway, tusd and SFU callbacks, with collision validation.

Generation used:

```sh
node scripts/configure.mjs \
  --app=meet.nikg.tech --rtc=rtc.nikg.tech --turn=turn.nikg.tech \
  --ip=108.165.32.23 --legacy-hosts=nikg.tech,media.nikg.tech \
  --gateway-port=18091 --hooks-port=18090
```

Do not rerun generation on the existing `.env`; it preserves current secrets by refusing overwrite. Configuration files containing secrets are root-only. Redis copies its configuration into a private tmpfs file owned by its runtime user; the original Linux deployment failed because the image dropped privileges before reading the root-only mount. The core also now waits for upload-volume ownership initialization.

Public new media: TCP 7881, UDP 7882, UDP 3478. Explicit UFW denies protect SFU API TCP 7880 and internal TURN TCP 5349. The existing firewall rules were preserved. `/etc/sysctl.d/90-cord-media.conf` sets socket buffer ceilings to 7,500,000 bytes so LiveKit can allocate its requested UDP receive buffer; these ceilings do not introduce an application playout delay.

The read-only preflight is `python3 scripts/cohost-cutover.py`; `--apply` performs the switch with automatic rollback on failure. Its rollback and concurrent-edit protection are covered by `python3 scripts/cohost_cutover_test.py`. The helper is scoped to this host and refuses to change anything before DNS, internal health and legacy route checks pass.

Pending public cutover: all three new A records must be `108.165.32.23`, DNS only, with no unverified AAAA. The existing Kiki Caddy owns 80/443. The prepared design moves only its TCP 443 publication to `127.0.0.1:8443`; new L4 edge then handles TCP 443. Existing `nikg.tech` and `media.nikg.tech` pass through as original TLS, keeping their Caddy configuration, certificates and authentication. Port 80 stays with Kiki. New names use TLS-ALPN ACME. No core/DB/worker restart is needed for that edge switch. Source IP at the legacy Caddy changes to the L4 peer; existing private media authorization also rejects proxy headers and remains closed by the existing Caddy routes.

## Verified so far

- 40 Maven tests passed: 19 H2 room tests, **19 real PostgreSQL tests with none skipped**, signaling gate and architecture tests. Java format and packaged JAR passed.
- 24 Vitest tests and production web build passed; frontend formatting passed.
- Four generator tests passed; both production Caddy gateway and L4 configurations validated in the pinned container images.
- Production containers boot on this Linux server; PostgreSQL/Redis health and production gateway API/HTML/negative access probes pass via actual PROXY protocol (`node scripts/smoke.mjs`).
- All nine existing Playwright scenarios passed against the built web bundle, real core/PostgreSQL/Redis/LiveKit/tusd and a loopback-only test gateway: eight in the main run, the file/video/audio/chat scenario in a focused rerun after correcting the test gateway's HTTP upload scheme. Includes two screen sources, independent control reconnect, media recovery, meeting-code admission, cached settings, favorites and upload offsets. Camera/audio and screen sources are synthetic. This is not an external-network or TURN/TLS measurement.
- Windows 0.2.2 at commit `20187a85db2b48f195622965ee8e3052e8af3628` passed build, tests, WinUI resources, offline installer compilation and installation/reinstallation/uninstallation on GitHub run `34321800143`. Installer was downloaded and verified: SHA-256 `b3568a2df536b50849418adddb53a64497668f70a02f662569620b1fb9915220`. A following workflow change now writes and requires the portable ZIP checksum too; its final artifacts must be rechecked before release.
- Native release PR: https://github.com/MikkiMays/ModernStreamingSystem.Windows/pull/1 . A new version is published by the workflow only from main after Windows checks pass.

Local logs and downloaded artifacts: `/opt/meet/import/`. Browser screenshots: `output/playwright/`. `.local/acceptance/` contains the temporary HTTP test gateway/Compose overrides; those overrides are no longer used by the running production core/gateway.

## Required remaining acceptance

1. DNS and publicly trusted TLS for meet/rtc/turn; shared-edge switch with baseline Kiki route checks and tested rollback.
2. Browser call through the actual HTTPS endpoint; received audio/video/screen frames; file download; admission/exit behavior.
3. Relay-only client with actual TURN/TLS media on TCP 443, not just a successful TLS handshake.
4. Final Windows artifact checks, publication as a downloadable GitHub release, and an actual native WebView2 connection to the deployed service. A resource-only WinUI check does not establish this.
5. Update deployment/installer instructions and preserve exact runtime/release evidence. Do not declare production ready while these items are missing.

Physical-device 1440p60, p50/p95 end-to-end latency, VPN/mobile network changes and multi-room saturation remain explicit measurement limits; localhost synthetic tests do not establish them.
