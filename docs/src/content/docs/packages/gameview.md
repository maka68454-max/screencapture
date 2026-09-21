---
title: Game View Canvas
description: Render the FiveM game view into a browser canvas with @screencapture/gameview.
---

`@screencapture/gameview` is a tiny browser package for FiveM NUI pages. It renders the player's current game view into an `HTMLCanvasElement` by using FiveM's external WebGL texture hook.

Use it when you are building NUI code that needs a canvas source for screenshots, `canvas.captureStream()`, WebCodecs, or custom capture UI. It is not useful in a normal website because the FiveM game texture only exists inside the game's NUI Chromium runtime.

## Install

```cmd
pnpm add @screencapture/gameview
```

In this repository, the game NUI package consumes it as a workspace dependency.

## `createGameView(canvas)`

```ts
import { createGameView } from '@screencapture/gameview';

const canvas = document.createElement('canvas');
document.body.append(canvas);

const gameView = createGameView(canvas);
gameView.resize(window.innerWidth, window.innerHeight);
```

| Value | Description |
| --- | --- |
| `canvas` | The canvas passed to `createGameView()`. |
| `gl` | The WebGL rendering context used by the package. |
| `resize(width, height)` | Updates the canvas size and WebGL viewport. |
| `dispose()` | Cancels rendering, loses the WebGL context, and removes the canvas from the DOM if it has a parent. |

The render loop starts immediately. Call `dispose()` when a capture, recording, or stream is finished.

## Responsive Canvas

```ts
import { createGameView } from '@screencapture/gameview';

const canvas = document.querySelector<HTMLCanvasElement>('#game-view');
if (!canvas) throw new Error('Missing canvas');

const gameView = createGameView(canvas);

function resizeGameView() {
  gameView.resize(window.innerWidth, window.innerHeight);
}

window.addEventListener('resize', resizeGameView);
resizeGameView();

window.addEventListener('unload', () => {
  window.removeEventListener('resize', resizeGameView);
  gameView.dispose();
});
```

## Capture A Still Image

The FiveM texture is not available synchronously on the first line after `createGameView()`. Wait a few animation frames before reading pixels from the canvas.

```ts
import { createGameView } from '@screencapture/gameview';

async function waitForFrames(count: number) {
  for (let frame = 0; frame < count; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/webp', quality = 0.92) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode canvas'));
    }, type, quality);
  });
}

export async function captureGameView(width = 1920, height = 1080) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const gameView = createGameView(canvas);
  gameView.resize(width, height);

  try {
    await waitForFrames(3);
    return await canvasToBlob(canvas);
  } finally {
    gameView.dispose();
  }
}
```

## Create A MediaStream

`canvas.captureStream()` turns the game-view canvas into a browser `MediaStream`. ScreenCapture uses this pattern internally for WebM recording and live publishing.

```ts
import { createGameView } from '@screencapture/gameview';

export async function createGameViewStream(width = 1280, height = 720, frameRate = 30) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const gameView = createGameView(canvas);
  gameView.resize(width, height);

  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

  const stream = canvas.captureStream(frameRate);

  return {
    stream,
    stop() {
      for (const track of stream.getTracks()) track.stop();
      gameView.dispose();
    },
  };
}
```

## Practical Notes

- Run this package only inside FiveM NUI.
- Keep capture dimensions as low as your use case allows. Live streaming is capped at 1280x720 and 30 FPS.
- Wait for at least two or three frames before encoding or streaming.
- Always stop tracks created from `canvas.captureStream()` and call `dispose()`.
- The supported game-view source is video-only. It does not expose game audio or microphone audio.