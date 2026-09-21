---
title: Realtime Workflows
description: Real-world patterns for using ScreenCapture live streaming in FiveM admin tools.
---

These examples assume you have deployed the live Worker with the [Cloudflare deploy button](/live-streaming/) and configured `screencapture_live_endpoint` in your server config.

Live streaming is video-only. The supported FiveM game-view source does not expose game audio or microphone audio, so FaceTime-style workflows should pair the video stream with your existing voice, radio, phone, or chat system.

## FaceTime-Style Staff Video Call

Use this pattern when an admin wants to open a temporary video session with a player during support, moderation, or roleplay staff calls. The player publishes one game-view stream, and the admin browser receives a one-time viewer token.

### Server Flow

```lua
local liveEndpoint = GetConvar('screencapture_live_endpoint', '')
local activeCallsByAdmin = {}

RegisterNetEvent('admin-video:start', function(targetSource)
    local adminSource = source
    targetSource = tonumber(targetSource)

    if not targetSource then return end
    if not IsPlayerAceAllowed(adminSource, 'screencapture.video_call') then return end

    local streamId = exports.screencapture:startLiveStream(targetSource, {
        duration = 600,
        maxViewers = 2,
        maxWidth = 1280,
        maxHeight = 720,
        frameRate = 30,
    }, function(result)
        if result.status ~= 'ready' then
            TriggerClientEvent('admin-video:error', adminSource, result.error or 'Stream failed')
            return
        end

        exports.screencapture:createLiveStreamViewerToken(result.streamId, function(grant)
            if grant.error then
                TriggerClientEvent('admin-video:error', adminSource, grant.error)
                return
            end

            activeCallsByAdmin[adminSource] = result.streamId

            TriggerClientEvent('admin-video:openViewer', adminSource, {
                endpoint = liveEndpoint,
                streamId = grant.streamId,
                viewerToken = grant.viewerToken,
                expiresAt = grant.expiresAt,
                targetSource = targetSource,
                targetName = GetPlayerName(targetSource),
            })
        end)
    end)

    TriggerClientEvent('admin-video:pending', adminSource, streamId)
end)

RegisterNetEvent('admin-video:stop', function()
    local adminSource = source
    local streamId = activeCallsByAdmin[adminSource]
    if not streamId then return end

    activeCallsByAdmin[adminSource] = nil
    exports.screencapture:stopLiveStream(streamId)
end)
```

Protect the start and stop events with your normal admin permission system. The example uses an ACE permission named `screencapture.video_call`.

### Admin Client Bridge

The `TriggerClientEvent('admin-video:openViewer', ...)` payload lands on the admin's FiveM client. In your admin resource's `client.lua`, forward it into your admin NUI with `SendNUIMessage()`, then let the browser code create the `ScreenCaptureViewer`.

```lua
RegisterNetEvent('admin-video:pending', function(streamId)
    SendNUIMessage({
        action = 'admin-video:pending',
        streamId = streamId,
    })
end)

RegisterNetEvent('admin-video:error', function(errorMessage)
    SendNUIMessage({
        action = 'admin-video:error',
        error = errorMessage,
    })
end)

RegisterNetEvent('admin-video:openViewer', function(grant)
    SetNuiFocus(true, true)

    SendNUIMessage({
        action = 'admin-video:openViewer',
        grant = grant,
    })
end)

RegisterNUICallback('admin-video:close', function(_, cb)
    SetNuiFocus(false, false)
    TriggerServerEvent('admin-video:stop')
    cb({ ok = true })
end)
```

If your admin panel already owns focus and routing, keep those parts in your existing UI layer and only forward the grant payload.

### Browser Viewer

```ts
import { ScreenCaptureViewer } from '@screencapture/live';

declare function GetParentResourceName(): string;

type VideoCallGrant = {
  endpoint: string;
  streamId: string;
  viewerToken: string;
  expiresAt?: number;
  targetSource?: number;
  targetName?: string;
};

type AdminVideoMessage =
  | { action: 'admin-video:pending'; streamId: string }
  | { action: 'admin-video:error'; error: string }
  | { action: 'admin-video:openViewer'; grant: VideoCallGrant };

let activeViewer: ScreenCaptureViewer | null = null;

export async function openVideoCall(grant: VideoCallGrant) {
  const video = document.querySelector<HTMLVideoElement>('#video-call');
  const title = document.querySelector<HTMLElement>('#video-call-title');
  if (!video) throw new Error('Missing video element');

  await activeViewer?.disconnect();

  video.muted = true;
  video.playsInline = true;
  if (title) title.textContent = grant.targetName ? `Viewing ${grant.targetName}` : 'Live game view';

  const viewer = new ScreenCaptureViewer({
    endpoint: grant.endpoint,
    streamId: grant.streamId,
    viewerToken: grant.viewerToken,
  });

  viewer.on('state', ({ state }) => {
    document.body.dataset.videoCallState = state;
  });

  viewer.on('error', ({ error }) => {
    console.error(error.code, error.message);
  });

  await viewer.connect();
  await viewer.attach(video);

  activeViewer = viewer;
}

export async function closeVideoCall() {
  await activeViewer?.disconnect();
  activeViewer = null;

    await fetch(`https://${GetParentResourceName()}/admin-video:close`, {
        method: 'POST',
        body: '{}',
    });
}

window.addEventListener('message', (event: MessageEvent<AdminVideoMessage>) => {
    const message = event.data;

    if (message.action === 'admin-video:openViewer') {
        void openVideoCall(message.grant);
        return;
    }

    if (message.action === 'admin-video:error') {
        console.error('[admin-video]', message.error);
        return;
    }

    if (message.action === 'admin-video:pending') {
        document.body.dataset.videoCallState = 'connecting';
    }
});
```

Call `closeVideoCall()` when the modal closes, the route changes, or the admin ends the call. The NUI callback notifies the FiveM client, and the client asks the server to stop the stream.

## Incident Room With Multiple Viewers

Use this pattern when several staff members need to watch the same player during an incident. Start one stream, then mint a separate viewer token for each authorized staff browser.

```lua
local function sendViewerGrant(streamId, staffSource)
    exports.screencapture:createLiveStreamViewerToken(streamId, function(grant)
        if grant.error then
            TriggerClientEvent('incident-room:error', staffSource, grant.error)
            return
        end

        TriggerClientEvent('incident-room:addStream', staffSource, {
            endpoint = GetConvar('screencapture_live_endpoint', ''),
            streamId = grant.streamId,
            viewerToken = grant.viewerToken,
            expiresAt = grant.expiresAt,
        })
    end)
end

local function startIncidentRoom(targetSource, staffSources)
    exports.screencapture:startLiveStream(targetSource, {
        duration = 900,
        maxViewers = #staffSources,
        maxWidth = 1280,
        maxHeight = 720,
    }, function(result)
        if result.status ~= 'ready' then return end

        for _, staffSource in ipairs(staffSources) do
            sendViewerGrant(result.streamId, staffSource)
        end
    end)
end
```

Do not share a viewer token across staff members. Each viewer tab needs its own grant so reconnects, heartbeats, and cleanup stay isolated.

## Dispatch Wall Or Supervisor Dashboard

Use this pattern for a dashboard with several small live tiles. Keep tiles muted, default them to `low` or `medium` quality, and disconnect streams that scroll out of view.

```ts
import { ScreenCaptureViewer } from '@screencapture/live';

type TileGrant = {
  endpoint: string;
  streamId: string;
  viewerToken: string;
};

export async function mountDispatchTile(grant: TileGrant, video: HTMLVideoElement) {
  const viewer = new ScreenCaptureViewer({ ...grant, autoReconnect: true });

  video.muted = true;
  video.playsInline = true;

  await viewer.connect();
  await viewer.attach(video);
  await viewer.setQuality('low');

  return () => viewer.disconnect();
}
```

For dashboards with many tiles, create grants only for visible tiles. When a tile is closed or replaced, call the cleanup function and request a fresh token before showing that stream again.

## When To Stop A Stream

Stop streams when the reason to observe is gone. Good stop triggers include:

- The admin closes a video call.
- An incident is resolved.
- The target player disconnects.
- The staff member loses permission to view the player.
- The dashboard tile is removed.

```lua
exports.screencapture:stopLiveStream(streamId, function(stopped)
    print(('Stopped live stream: %s'):format(stopped and 'yes' or 'no'))
end)
```

The stream also expires automatically after its configured `duration`, up to the service maximum.