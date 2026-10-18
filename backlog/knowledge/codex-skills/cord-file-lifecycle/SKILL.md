---
name: cord-file-lifecycle
description: "Cord uploads and retention: tus, ownership checks, quotas, temporary chat/files and cleanup."
---

# cord-file-lifecycle

Map tusd, gateway, server metadata and storage. Verify authorization on create, HEAD, PATCH and download; bind ownership to the correct room, member and session. Check resume offsets, retries, duplicate completion, SHA-256, partial failures, quotas, races and expired uploads. Distinguish immediate logical expiry from delayed physical deletion. Prove old messages and files stay expired when a favorite room is reopened. Test unavailable storage and cleanup retry using disposable data only.
