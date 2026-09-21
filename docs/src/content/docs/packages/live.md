---
title: Live Viewer SDK
description: Connect browser admin panels to ScreenCapture live streams with @screencapture/live.
---

`@screencapture/live` is a framework-neutral browser SDK for viewing ScreenCapture live streams. It handles viewer signaling, WebRTC answer creation, reconnects, heartbeats, quality changes, and video attachment.

The package does not start streams. Start streams from the FiveM server with `startLiveStream()`, create one-time viewer grants with `createLiveStreamViewerToken()`, then pass the grant to your browser UI.

## Install

```cmd
pnpm add @screencapture/live
```

## Token Flow

1. A trusted server-side admin action calls `exports.screencapture:startLiveStream(playerSource, options, callback)`.
2. The callback fires with `status: 'ready'` after the player is publishing to the live Worker.
3. Your server calls `exports.screencapture:createLiveStreamViewerToken(streamId, callback)` for each authorized browser viewer.
4. Your admin UI receives `endpoint`, `streamId`, and `viewerToken` through your own authenticated channel.
5. The browser creates `ScreenCaptureViewer` and attaches the stream to a `video` element.

Viewer tokens are short-lived and one-time-use. Do not put them in URLs, logs, analytics events, or shared browser state.

## Basic Viewer

```ts
import { ScreenCaptureViewer } from '@screencapture/live';

type ViewerGrant = {
  endpoint: string;
  streamId: string;
  viewerToken: string;
};

export async function openViewer(grant: ViewerGrant, videoElement: HTMLVideoElement) {
  videoElement.muted = true;
  videoElement.playsInline = true;

  const viewer = new ScreenCaptureViewer({
    endpoint: grant.endpoint,
    streamId: grant.streamId,
    viewerToken: grant.viewerToken,
  });

  viewer.on('state', ({ state }) => {
    console.log('[screencapture] viewer state:', state);
  });

  viewer.on('error', ({ error }) => {
    console.error('[screencapture] viewer error:', error.code, error.message);
  });

  await viewer.connect();
  await viewer.attach(videoElement);
  await viewer.setQuality('auto');

  return viewer;
}
```

## Constructor Options

| Option | Type | Description |
| --- | --- | --- |
| `endpoint` | `string` | HTTPS URL of the deployed live Worker. Localhost is allowed for development. |
| `streamId` | `string` | Public stream ID returned by `startLiveStream()`. |
| `viewerToken` | `string` | One-time token returned by `createLiveStreamViewerToken()`. |
| `autoReconnect` | `boolean` | Optional. Defaults to `true` and retries failed viewer sessions up to three times. |

## Events

| Event | Payload | Description |
| --- | --- | --- |
| `state` | `{ state }` | Fires when the viewer enters `idle`, `connecting`, `connected`, `reconnecting`, `disconnected`, or `failed`. |
| `track` | `{ track, stream }` | Fires when a remote media track arrives. |
| `error` | `{ error }` | Fires with `ScreenCaptureViewerError` for configuration, signaling, connection, or autoplay failures. |

`on()` returns an unsubscribe function.

```ts
const offState = viewer.on('state', ({ state }) => updateBadge(state));
offState();
```

## Methods

| Method | Description |
| --- | --- |
| `connect()` | Creates the WebRTC viewer session and returns the `MediaStream`. |
| `attach(videoElement)` | Assigns the stream to a video element and calls `play()`. |
| `setQuality('auto' \| 'high' \| 'medium' \| 'low')` | Requests a viewer quality level from the live Worker. |
| `getStats()` | Returns the underlying `RTCStatsReport`. Useful for diagnostics. |
| `disconnect()` | Stops local tracks, clears heartbeats, and releases the remote viewer session. |

## Autoplay

Browsers may block `video.play()` unless the call comes from a user gesture or the element is muted. For admin dashboards, keep the viewer video muted and call `attach()` from the click that opens the viewer.

```ts
openButton.addEventListener('click', async () => {
  video.muted = true;
  await viewer.connect();
  await viewer.attach(video);
});
```

## Quality Controls

Use quality controls when a dashboard may show several viewers at once.

```ts
qualitySelect.addEventListener('change', () => {
  void viewer.setQuality(qualitySelect.value as 'auto' | 'high' | 'medium' | 'low');
});
```

## Cleanup

Disconnect viewers when a modal closes, a route changes, or the admin loses permission to view the stream.

```ts
window.addEventListener('beforeunload', () => {
  void viewer.disconnect();
});
```

## Error Codes

| Code | Typical cause |
| --- | --- |
| `configuration` | Invalid endpoint, stream ID, or missing viewer token. |
| `signaling` | The Worker rejected the request, timed out, or returned an invalid session. |
| `connection` | WebRTC connection failed or could not reconnect. |
| `autoplay` | The browser blocked video playback. |

## Security Checklist

- Create viewer tokens only after authenticating and authorizing the viewer.
- Create a separate viewer token for every browser tab or viewer slot.
- Do not reuse viewer grants.
- Keep viewer tokens out of query strings and URLs.
- Stop streams with `stopLiveStream()` when the admin workflow is complete.