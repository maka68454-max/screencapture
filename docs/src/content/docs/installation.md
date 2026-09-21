---
title: Installation
description: Install ScreenCapture from the latest release zip.
---

## Install The Resource

Download `screencapture.zip` from the [latest ScreenCapture release](https://github.com/itschip/screencapture/releases/latest).

Extract the zip into your server resources folder so the resource path is `resources/screencapture`.

Add it before resources that call its exports:

```text
ensure screencapture
```

## Resource Order

Resources that call ScreenCapture exports should start after `screencapture`. If you rely on `screenshot-basic` compatibility, keep the resource name as `screencapture` and let the manifest provide the compatibility layer.

The release zip already includes the built game and NUI bundles. The Cloudflare live streaming service is deployed separately from the [live streaming guide](/live-streaming/).