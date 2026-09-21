---
title: Video Capture
description: Record timed or manual WebM captures through the player's NUI.
---

Video capture is experimental. It records WebM video through the player's NUI, streams chunks to the server, assembles the file in `screencapture/tmp/`, and calls your callback after finalization.

## Timed Capture

```lua
local captureId = exports.screencapture:startVideoCapture(source, {
    duration = 10,
    maxWidth = 1280,
    maxHeight = 720,
}, function(result)
    if result.status ~= 'success' then
        print(('Video capture failed: %s'):format(result.error or 'unknown error'))
        return
    end

    print(('Saved %s with %d bytes'):format(result.filePath, result.bytesReceived or 0))
end)

print(('Started capture %s'):format(captureId))
```

## Manual Capture

```lua
local captureId = exports.screencapture:startVideoCapture(source, {}, function(result)
    print(result.filePath)
end)

-- Stop when your workflow is finished.
exports.screencapture:stopVideoCapture(captureId)
```

## Capture And Upload

```lua
local captureId = exports.screencapture:startVideoCaptureUpload(source, 'https://api.fivemanage.com/api/v3/file', {
    duration = 15,
    headers = { ['Authorization'] = 'your-api-key' },
    formField = 'file',
    filename = 'gameplay',
}, function(result)
    if result.status ~= 'success' then
        print(('Upload failed: %s'):format(result.error or 'unknown error'))
        return
    end

    print(result.response.data.url)
end)
```

## `startVideoCapture(source, options, callback)`

Starts a recording for a player and returns a public `captureId`. If `duration` is provided, the capture stops automatically.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | `number` | Yes | Player source to record. |
| `options` | `VideoCaptureOptions` | No | Capture dimensions and optional duration. |
| `callback` | `function` | No | Called when the recording is finalized. |

## `startVideoCaptureUpload(source, url, options, callback)`

Starts a recording, uploads the finalized WebM, deletes the temp file, and returns a public `captureId`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | `number` | Yes | Player source to record. |
| `url` | `string` | Yes | Remote upload endpoint. |
| `options` | `VideoUploadOptions` | No | Capture and upload options. |
| `callback` | `function` | No | Called with the finalized upload result. |

## Stop Or Check Captures

`stopVideoCapture(captureId)` stops an active capture by its public ID.

```lua
if exports.screencapture:isVideoCaptureActive(captureId) then
    exports.screencapture:stopVideoCapture(captureId)
end
```

`isVideoCaptureActive(captureId)` returns `true` if the capture ID is currently active, otherwise `false`.

## Video Options

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `duration` | `number` | | Optional duration in seconds. Must be positive when provided. |
| `maxWidth` | `number` | `1920` | Maximum capture width in pixels. |
| `maxHeight` | `number` | `1080` | Maximum capture height in pixels. |
| `headers` | `object` | `{}` | Remote upload headers for `startVideoCaptureUpload`. |
| `formField` | `string` | `'file'` | FormData field name for video upload. |
| `filename` | `string` | `'recording'` | Upload file name. `.webm` is appended. |

## Video Result

Modern video callbacks receive a structured result.

```ts
type VideoCaptureResult = {
  captureId: string;
  source: number;
  status: 'success' | 'error';
  filePath?: string;
  response?: unknown;
  bytesReceived: number;
  duration?: number;
  reason?: 'manual' | 'duration' | 'finalized';
  error?: string;
};
```

Local captures return `filePath` on success. Remote captures return `response` on success.