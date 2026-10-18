---
name: cord-media-reliability
description: "Cord/ModernStreamingSystem LiveKit and WebRTC work: media quality, reconnects, screen sharing and device bugs."
---

# cord-media-reliability

Trace signaling, server authorization and media separately. Check participant identity, connection generations, the recovery deadline, stale callbacks, publish reservations and duplicate events. Measure getStats: bitrate, FPS, frames dropped, RTT, loss, jitter, codec and the selected ICE candidate. Distinguish a static screen from stalled decoding. Exercise reconnects, revoked tokens, two screen shares, device replacement and track disposal. Never claim TURN/TLS or hardware 1440p60 acceptance from unit tests or fake media. Use isolated test rooms only.
