---
title: Compatibility Exports
description: Use ScreenCapture as a screenshot-basic compatible resource.
---

ScreenCapture provides `screenshot-basic` compatibility with `provide 'screenshot-basic'`.

## Server Compatibility

| Export | Status | Notes |
| --- | --- | --- |
| `requestClientScreenshot` | Supported | Server-side screenshot-basic compatible export. |
| `serverCaptureStream` | Supported legacy alias | Starts video capture and returns `captureId`; callback receives the old local payload. |
| `remoteUploadStream` | Supported legacy alias | Starts video capture upload and returns `captureId`; callback receives the old remote payload. |
| `INTERNAL_stopServerCaptureStream` | Supported legacy alias | Stops the active stream for a source. |
| `stopStream` | Supported legacy alias | Stops the active stream for a source. |

## Client Compatibility

`requestScreenshotUpload` uploads from the client. Prefer server-side `remoteUpload` because client-side upload exposes upload details to the client.

```lua
exports['screencapture']:requestScreenshotUpload('https://api.fivemanage.com/api/v3/file', 'file', {
    headers = { ['Authorization'] = 'your-api-key' },
    encoding = 'webp',
}, function(data)
    local response = json.decode(data)
    print(response.url)
end)
```

`requestScreenshot` returns a base64 data URI to the client callback.

```lua
exports['screencapture']:requestScreenshot({ encoding = 'jpg' }, function(data)
    print(data)
end)
```