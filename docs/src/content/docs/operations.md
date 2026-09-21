---
title: Operations
description: Operational notes and troubleshooting checks for ScreenCapture.
---

## Operational Notes

- Only one active video capture is allowed per player source.
- Local video captures are written to `screencapture/tmp/`; callers are responsible for moving or deleting files they keep.
- Remote video uploads delete the temp WebM after upload processing.
- Do not expose API keys to client-side exports. Use server-side `remoteUpload` or `startVideoCaptureUpload` for authenticated upload targets.
- Video recording depends on WebCodecs support in FiveM's bundled Chromium. If VP9 encoding is unavailable, recording may produce an invalid or header-only WebM.
- Prefer `webp` screenshots for a good quality-to-size balance.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `source is required` | Pass a valid player source from the server. |
| Upload endpoint receives no file | Check `formField`, auth headers, and whether the remote endpoint expects binary multipart data. |
| Video does not stop | Store the returned `captureId` and pass it to `stopVideoCapture`. |
| A player cannot start another video | The player already has an active capture; stop or wait for the current one to finalize. |
| Uploads fail with `http` protocol | Try `protocol 'nui'` in `fxmanifest.lua`. |
| Transfers are slow | Increase `images_bps` or `stream_bps` cautiously. |