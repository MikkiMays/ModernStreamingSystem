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

Public cutover was completed on 9 September 2026. All three new A records are `108.165.32.23`, DNS only, with no AAAA. Kiki Caddy keeps port 80 and publishes its TLS listener at `127.0.0.1:8443`; the Cord L4 edge owns public TCP 443. Existing `nikg.tech` and `media.nikg.tech` pass through as original TLS, keeping their Caddy configuration, certificates and authentication. Port 80 stays with Kiki. New names use TLS-ALPN ACME. No core/DB/worker restart is needed for that edge switch. Source IP at the legacy Caddy changes to the L4 peer; existing private media authorization also rejects proxy headers and remains closed by the existing Caddy routes.

## Build and regression evidence

- 40 Maven tests passed: 19 H2 room tests, **19 real PostgreSQL tests with none skipped**, signaling gate and architecture tests. Java format and packaged JAR passed.
- Initial 24 Vitest tests passed. Upstream main advanced during deployment to `4bfe2a845a6f58c23708ce16af432540d0b838d0`; its screen-publication permission fix and Windows CI process-lifetime fix were merged into this branch. The resulting **32 Vitest tests**, formatting and production web build passed. The updated two-screen/third-screen-rejection scenario passed again against the rebuilt container after waiting for core readiness. Compose now gates gateway startup on the core health check to avoid the observed first-boot race.
- Four generator tests passed; both production Caddy gateway and L4 configurations validated in the pinned container images.
- Production containers boot on this Linux server; PostgreSQL/Redis health and production gateway API/HTML/negative access probes pass via actual PROXY protocol (`node scripts/smoke.mjs`).
- All nine existing Playwright scenarios passed against the built web bundle, real core/PostgreSQL/Redis/LiveKit/tusd and a loopback-only test gateway: eight in the main run, the file/video/audio/chat scenario in a focused rerun after correcting the test gateway's HTTP upload scheme. Includes two screen sources, independent control reconnect, media recovery, meeting-code admission, cached settings, favorites and upload offsets. Camera/audio and screen sources are synthetic. This is not an external-network or TURN/TLS measurement.
- Windows 0.2.2 at commit `20187a85db2b48f195622965ee8e3052e8af3628` passed build, tests, WinUI resources, offline installer compilation and installation/reinstallation/uninstallation on GitHub run `34321800143`. Installer was downloaded and verified: SHA-256 `b3568a2df536b50849418adddb53a64497668f70a02f662569620b1fb9915220`. The portable-checksum follow-up passed Windows run `34322599643`. The latest change also requires an actual native WebView2/React bridge/HTTPS/favorites API check from a fresh profile before a main-branch release; branch builds deliberately do not claim that DNS-dependent check passed. Final artifacts must be rechecked before release.
- Native release PR: https://github.com/MikkiMays/ModernStreamingSystem.Windows/pull/1 . A new version is published by the workflow only from main after Windows checks pass.
- Final Windows branch commit `e0fa6efd4e8f4275c31dc99c8dc7d7f9397fbf5a` passed run `34323730252`, including offline installer lifecycle and both distribution checksums. The native production connection probe runs before a main-branch release; final release evidence is recorded below.
- Server run `34323601991` passed Java and production-container deployment checks, but the Windows two-screen scenario exceeded its 12-second receive deadline. Its retained trace shows one video at 119124ms and two at 120356ms, 12.8 seconds after the assertion began; failure screenshots show both animated sources. The scenario now allows 30 seconds for stream startup and additionally requires decoded frame counts to advance on **both** received videos. The strengthened scenario passed locally against the real containers in 28.6 seconds and in the final Windows CI run. Capture resolution/rate and all screen-limit, pinning, camera and audio assertions remain in place.
- Subsequent main commits through `0b2afcc33a7c93115f080e224c05c573eb8caef7` add upstream acceptance documentation and a default 720p30 synthetic screen source for shared CI resources, retaining 1440p60 via `SCREEN_TEST_HIGH_RESOLUTION=1`. These were merged with the advancing-frame assertion above. This changes the functional fixture, not application capture profiles or production media settings. Windows main remains `6dd05c50a703cc265d30d6f804914bc64b8968b1` at this synchronization.
- The combined two-screen scenario passed on this host in **both** modes: 720p30 in 25.3 seconds and 1440p60 in 32.9 seconds. Each run used the actual SFU/container backend, required moving decoded frames on both remote videos and rejected a third screen. The production core/gateway configuration was restored afterward.

Server release PR: https://github.com/MikkiMays/ModernStreamingSystem/pull/9 .

Local logs and downloaded artifacts: `/opt/meet/import/`. Browser screenshots: `output/playwright/`. `.local/acceptance/` contains the temporary HTTP test gateway/Compose overrides; those overrides are no longer used by the running production core/gateway.

## Public acceptance

- [Server CI 34326660214](https://github.com/MikkiMays/ModernStreamingSystem/actions/runs/34326660214) passed Java/PostgreSQL, all nine browser scenarios on Windows, and the production-container checks. Server PR #9 was merged as `c7e463640ca2ae513f03e9b17d5046a9b267eb76`.
- All nine browser scenarios passed through `https://meet.nikg.tech` from this host in 1.7 minutes, then from an **external Windows runner** in [public acceptance 34326656307](https://github.com/MikkiMays/ModernStreamingSystem/actions/runs/34326656307). This covers real HTTPS, SFU calls, screen limits and received frames, files, admission and recovery; sources are synthetic.
- Two separate browser processes were forced to `iceTransportPolicy: relay` with only `turns:turn.nikg.tech:443?transport=tcp`. On **both** selected connections, browser stats reported `candidateType: relay`, `relayProtocol: tls`, and that exact TURN URL. Incoming video frames, audio samples and audio energy increased in both directions. Evidence: `/opt/meet/import/relay-public-host.json`, `relay-public-guest.json`; reviewed image `output/playwright/turn-tls-443.png`. This is actual TURN/TLS media through the public TLS endpoint, measured from this host; the external Windows call is a separate internet-path check.
- Public trusted certificates validate for meet/rtc/turn. The five legacy route checks pass: Kiki home 200, task API 401, internal 403, actuator 403 and media root 403. The first switch rolled back because Docker reported Caddy started before TLS readiness; bounded readiness checks fixed that race on both cutover and rollback. All **five** cutover tests pass. Successful backup: `.local/cohost-backups/20260909T075644Z`.
- The single Kiki Compose port-publication change is committed locally as `cf24e6f` on `deploy/cord-tls-cohost`. Kiki core, database and workers were not restarted. The existing media path still uses proxied HTTPS signaling and direct ICE media at `108.165.32.23:8189`; no Kiki/Klodi media transport was rewritten.

## Windows release

Windows PR #1 was merged as `b6a13dec915c47a91054c7092cf4a92699a456d0`. [Release workflow 34327185608](https://github.com/MikkiMays/ModernStreamingSystem.Windows/actions/runs/34327185608) passed all 16 tests, publication, WinUI resources, the actual native production connection from a fresh profile, installation/reinstallation/uninstallation and distribution checksums. The native probe opened the real WinUI/WebView2 window, rendered the shared desktop home over trusted HTTPS, completed its typed bridge and called the native favorites API.

[Cord 0.2.2](https://github.com/MikkiMays/ModernStreamingSystem.Windows/releases/tag/v0.2.2) is published as a normal release, with all four assets uploaded. The downloaded final build artifact's checksum was verified; both distributions and both checksum files match the GitHub release asset digests byte for byte.

- Installer: `Cord-Setup-0.2.2-x64.exe`, 324178841 bytes, SHA-256 `016f2b163cf2ceba4ec651ad0a7bb3445b7d1fcef281c05b89c01ed58fe64097`.
- Portable ZIP: `Cord-win-x64.zip`, 94075866 bytes, SHA-256 `432cdf6d7a88e86c5d39e57adfdc1646f33e18ed05b6e7ffaa4891670f83405d`.
- New profiles use `https://meet.nikg.tech/`. Existing explicitly saved endpoints remain unchanged. The installer includes the required runtimes and requires Windows x64, Windows 10 build 19041 or later; it has no publisher signature yet.
- Evidence: `/opt/meet/import/windows-production-verification.log`, `release-0.2.2-verification.json`, `windows-0.2.2-release/`. Physical device permissions and hardware capture remain device-specific checks; the media acceptance above uses synthetic sources.

## Operations and measurement limits

Normal service reconciliation: `docker compose up -d` from this repository. Check `node scripts/smoke.mjs`, then `python3 scripts/cohost-cutover.py`; after cutover the latter verifies the existing public setup. Keep the legacy loopback port 8443 publication when updating Kiki. A manual rollback must stop the Cord edge before returning Kiki's publication to 443; preserve any later Kiki edits instead of blindly copying an old Compose backup.

Existing Kiki `media.nikg.tech` may remain Cloudflare-proxied because its HTTPS signaling supplies the direct media IP in ICE. Cord's TURN hostname must be DNS only: standard Cloudflare HTTP proxying cannot carry TURN/TLS. Meet/RTC also stay DNS only in this deployment because certificate issuance uses TLS-ALPN on the shared edge.

Physical-device 1440p60, p50/p95 end-to-end latency, VPN/mobile network changes and multi-room saturation remain measurement limits; synthetic functional tests do not establish those performance claims.
