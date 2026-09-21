---
title: Live Streaming
description: Stream one player's game view to browser viewers with Cloudflare Realtime SFU.
---

Live streaming sends one WebRTC upstream from the player to Cloudflare Realtime SFU. Browser viewers receive separate SFU sessions, so adding viewers does not increase the player's upload count and no video payload is carried by FiveM events.

For end-to-end admin workflows, see the [realtime examples](/examples/realtime/). For browser integration details, see the [`@screencapture/live` package](/packages/live/).

## Deployment

Create a Cloudflare Realtime SFU app, then deploy only the live streaming Worker with the quick deploy button. You do not need to build or deploy the main ScreenCapture FiveM resource for this step.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/itschip/screencapture/tree/main/workers/live)

The Cloudflare form prompts for your Realtime App ID and App Secret. Cloudflare deploys the Worker and automatically provisions its SQLite Durable Object.

After deployment finishes, copy the deployed Worker URL into your server config before starting the resource:

```text
set screencapture_live_endpoint "https://screencapture-live.<account>.workers.dev"
```

The service uses one SQLite Durable Object per unguessable stream ID. The owner capability remains on the FiveM server, the publisher capability is sent only to the selected player's NUI, and every viewer receives a separate one-time capability.

The public creation endpoint is limited to 10 requests per minute for each IP and Cloudflare location. This limiter is permissive and does not prevent distributed abuse; use Cloudflare WAF controls and budget alerts for a public deployment.

## `startLiveStream(source, options, callback)`

`startLiveStream(source, options, callback)` returns a `streamId` immediately. The callback fires once when publication is ready or setup fails.

| Option | Default | Maximum | Description |
| --- | ---: | ---: | --- |
| `maxWidth` | `1280` | `1280` | Published video width. |
| `maxHeight` | `720` | `720` | Published video height. |
| `frameRate` | `30` | `30` | Published frames per second. |
| `duration` | `1800` | `1800` | Stream lifetime in seconds. |
| `maxViewers` | `25` | `25` | Concurrent viewer leases. |

```lua
local streamId = exports.screencapture:startLiveStream(source, {
    duration = 900,
    maxWidth = 1280,
    maxHeight = 720,
}, function(result)
    if result.status == 'ready' then
        print(('Stream ready: %s'):format(result.streamId))
    else
        print(('Stream failed: %s'):format(result.error))
    end
end)
```

## Viewer Grants

`createLiveStreamViewerToken(streamId, callback)` creates a one-time grant that expires after 60 seconds. Call it only after authenticating an administrator in your own server or backend.

`stopLiveStream(streamId, callback?)` stops the NUI publisher and removes SFU state. `isLiveStreamActive(streamId)` reports local lifecycle state.

`screencapture:liveStreamEnded` emits `streamId`, player source, reason, and an optional error for manual stop, expiry, disconnect, publication failure, or resource stop.

## Viewer SDK

Install or bundle `@screencapture/live` into the creator's admin panel.

```ts
import { ScreenCaptureViewer } from '@screencapture/live';

const viewer = new ScreenCaptureViewer({
  endpoint,
  streamId: grant.streamId,
  viewerToken: grant.viewerToken,
});

viewer.on('state', ({ state }) => console.log(state));
viewer.on('error', ({ error }) => console.error(error.code, error.message));

await viewer.connect();
await viewer.attach(videoElement);
await viewer.setQuality('auto');
```

Available quality values are `auto`, `high`, `medium`, and `low`. The SDK maintains viewer heartbeats, retries failed sessions up to three times, reuses the viewer slot during reconnect, and exposes `getStats()` and `disconnect()`.

Browser autoplay policy may require `attach()` to run from a user interaction or the video element to be muted. Never put viewer tokens in query strings, browser logs, or analytics.

## Privacy And Audio

The player sees a non-disableable indicator while connecting, live, or reconnecting. Live streaming and WebM recording are mutually exclusive per player. Screenshots remain independent.

The supported FiveM game-view canvas currently provides video only. The stream reports `audioAvailable: false` and continues normally. It never requests microphone access or substitutes microphone audio for game output.