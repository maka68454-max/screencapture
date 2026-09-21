import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import { liveStreamStore, uploadStore } from './bootstrap';
import {
  CallbackFn,
  CaptureOptions,
  DataType,
  LiveStreamCallback,
  LiveStreamOptions,
  LiveStreamViewerGrant,
  ScreenshotBasicCallbackFn,
  StreamRemoteConfig,
  createScreenshotBasicUploadData,
  createRegularUploadData,
} from './types';
import { endLiveStream, getLiveStreamClient, provisionLiveStream } from './live';
import { exportHandler } from './utils';
import { nanoid } from 'nanoid';
import { emitNetToPlayer, validatePlayerSource } from './net';

type PlayerSource = number | string;

const tempDir = path.join(GetResourcePath(GetCurrentResourceName()), 'tmp');
mkdir(tempDir, { recursive: true }).catch((err) => {
  console.error('[screencapture] Failed to create temp directory:', err);
});

function normalizeStreamOptions(options: CaptureOptions = {}, duration?: number): CaptureOptions {
  return {
    ...options,
    ...(duration !== undefined && options.duration === undefined && { duration }),
  };
}

function validateStreamRequest(source: PlayerSource, options: CaptureOptions, exportName: string): number | undefined {
  const playerSource = validatePlayerSource(source, exportName);
  if (!playerSource) return;

  if (options.duration !== undefined && (!Number.isFinite(options.duration) || options.duration <= 0)) {
    console.error(`[screencapture] duration must be a positive number for ${exportName}`);
    return;
  }

  if (uploadStore.hasActiveStreamForSource(playerSource)) {
    console.error(`[screencapture] source ${playerSource} already has an active video capture`);
    return;
  }

  if (liveStreamStore.hasActiveStreamForSource(playerSource)) {
    console.error(`[screencapture] source ${playerSource} already has an active live stream`);
    return;
  }

  return playerSource;
}

function normalizeLiveStreamOptions(options: LiveStreamOptions = {}): Required<LiveStreamOptions> | undefined {
  const normalized = {
    maxWidth: options.maxWidth ?? 1280,
    maxHeight: options.maxHeight ?? 720,
    frameRate: options.frameRate ?? 30,
    duration: options.duration ?? 1800,
    maxViewers: options.maxViewers ?? 25,
  };

  const values = Object.values(normalized);
  if (values.some((value) => !Number.isFinite(value) || !Number.isInteger(value) || value < 1)) return;

  return {
    maxWidth: Math.min(normalized.maxWidth, 1280),
    maxHeight: Math.min(normalized.maxHeight, 720),
    frameRate: Math.min(normalized.frameRate, 30),
    duration: Math.min(normalized.duration, 1800),
    maxViewers: Math.min(normalized.maxViewers, 25),
  };
}

function startLiveStream(
  source: PlayerSource,
  options: LiveStreamOptions = {},
  callback: LiveStreamCallback = () => {},
): string {
  const streamId = nanoid(24);
  const realCallback = typeof callback === 'function' ? callback : () => {};

  const fail = (error: string): string => {
    console.error(`[screencapture] cannot start live stream: ${error}`);
    realCallback({ streamId, source: playerSource ?? 0, status: 'error', error });
    return streamId;
  };

  const playerSource = validatePlayerSource(source, 'startLiveStream');
  if (!playerSource) {
    return fail('source is required for startLiveStream');
  }

  const normalizedOptions = normalizeLiveStreamOptions(options);
  if (!normalizedOptions) {
    return fail('live stream options must be positive integers');
  }

  if (uploadStore.hasActiveStreamForSource(playerSource) || liveStreamStore.hasActiveStreamForSource(playerSource)) {
    return fail(`source ${playerSource} already has an active video capture`);
  }

  try {
    getLiveStreamClient();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  try {
    liveStreamStore.addPending(streamId, playerSource, realCallback);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  void provisionLiveStream(streamId, playerSource, normalizedOptions);
  return streamId;
}

global.exports('startLiveStream', startLiveStream);

global.exports(
  'createLiveStreamViewerToken',
  (streamId: string, callback: (result: LiveStreamViewerGrant | { error: string }) => void) => {
    if (!streamId || typeof callback !== 'function') return;

    void (async () => {
      try {
        const entry = liveStreamStore.get(streamId);
        if (entry.state !== 'live' || !entry.ownerToken) {
          throw new Error('Live stream is not ready for viewers');
        }
        callback(await getLiveStreamClient().createViewerToken(streamId, entry.ownerToken));
      } catch (error) {
        callback({ error: error instanceof Error ? error.message : 'Could not create viewer token' });
      }
    })();
  },
);

global.exports('stopLiveStream', (streamId: string, callback?: (stopped: boolean) => void) => {
  if (!streamId) return callback?.(false);
  void endLiveStream(streamId, 'manual').then((stopped) => callback?.(stopped));
});

global.exports('isLiveStreamActive', (streamId: string) => Boolean(streamId && liveStreamStore.has(streamId)));

function startVideoCapture(
  source: PlayerSource,
  options: CaptureOptions = {},
  callback: CallbackFn = () => {},
  legacyCallback = false,
): string | undefined {
  const playerSource = validateStreamRequest(
    source,
    options,
    legacyCallback ? 'serverCaptureStream' : 'startVideoCapture',
  );
  if (!playerSource) return;

  const captureId = nanoid(24);
  console.log(`[screencapture] Starting video capture for source ${playerSource} with capture ID ${captureId}`);

  const token = uploadStore.addStream({
    captureId,
    source: playerSource,
    tempDir,
    callback,
    duration: options.duration,
    legacyCallback,
  });

  emitNetToPlayer('screencapture:captureStream', playerSource, token, options, captureId);

  return captureId;
}

function startVideoCaptureUpload(
  source: PlayerSource,
  url: string,
  options: StreamRemoteConfig & Pick<CaptureOptions, 'maxWidth' | 'maxHeight' | 'duration'> = {},
  callback: CallbackFn = () => {},
  legacyCallback = false,
): string | undefined {
  if (!url) {
    console.error(`[screencapture] url is required for ${legacyCallback ? 'remoteUploadStream' : 'startVideoCaptureUpload'}`);
    return;
  }

  const playerSource = validateStreamRequest(
    source,
    options,
    legacyCallback ? 'remoteUploadStream' : 'startVideoCaptureUpload',
  );
  if (!playerSource) return;

  const captureId = nanoid(24);
  console.log(`[screencapture] Starting remote video capture for source ${playerSource} with capture ID ${captureId}`);

  const token = uploadStore.addStream({
    captureId,
    source: playerSource,
    tempDir,
    callback,
    duration: options.duration,
    isRemote: true,
    remoteUrl: url,
    remoteConfig: {
      headers: options?.headers,
      formField: options?.formField,
      filename: options?.filename,
    },
    legacyCallback,
  });

  emitNetToPlayer('screencapture:captureStream', playerSource, token, options, captureId);

  return captureId;
}

global.exports('startVideoCapture', startVideoCapture);
global.exports('startVideoCaptureUpload', startVideoCaptureUpload);
global.exports('serverCaptureStream', (source: PlayerSource, options: CaptureOptions, callback: CallbackFn, duration?: number) => {
  return startVideoCapture(source, normalizeStreamOptions(options ?? {}, duration), callback ?? (() => {}), true);
});


global.exports(
  'remoteUploadStream',
  (
    source: PlayerSource,
    url: string,
    options: StreamRemoteConfig & Pick<CaptureOptions, 'maxWidth' | 'maxHeight'>,
    callback: CallbackFn,
    duration?: number,
  ) => {
    return startVideoCaptureUpload(source, url, normalizeStreamOptions(options ?? {}, duration), callback ?? (() => {}), true);
  },
);

global.exports('stopVideoCapture', (captureId: string) => {
  if (!captureId) return console.error('[screencapture] captureId is required for stopVideoCapture');

  try {
    const streamData = uploadStore.getStreamByCaptureId(captureId);
    emitNetToPlayer('screencapture:INTERNAL:stopCaptureStream', streamData.source, captureId);
  } catch (err) {
    console.error('[screencapture] stopVideoCapture failed:', err);
  }
});

global.exports('isVideoCaptureActive', (captureId: string) => {
  if (!captureId) return false;

  try {
    uploadStore.getStreamByCaptureId(captureId);
    return true;
  } catch {
    return false;
  }
});

global.exports('INTERNAL_stopServerCaptureStream', (source: PlayerSource) => {
  const playerSource = validatePlayerSource(source, 'stop server capture stream');
  if (!playerSource) return;

  const captureId = uploadStore.getCaptureIdBySource(playerSource);
  if (!captureId) return console.error(`[screencapture] source ${playerSource} has no active video capture`);

  emitNetToPlayer('screencapture:INTERNAL:stopCaptureStream', playerSource, captureId);
});

global.exports('stopStream', (source: PlayerSource) => {
  const playerSource = validatePlayerSource(source, 'stop stream');
  if (!playerSource) return;

  const captureId = uploadStore.getCaptureIdBySource(playerSource);
  if (!captureId) return console.error(`[screencapture] source ${playerSource} has no active video capture`);

  emitNetToPlayer('screencapture:INTERNAL:stopCaptureStream', playerSource, captureId);
});

global.exports(
  'remoteUpload',
  (source: PlayerSource, url: string, options: CaptureOptions, callback: CallbackFn, dataType: DataType = 'base64') => {
    const playerSource = validatePlayerSource(source, 'remoteUpload');
    if (!playerSource) return;

    const token = uploadStore.addUpload(
      createRegularUploadData({
        callback: callback,
        isRemote: true,
        remoteConfig: {
          ...options,
          encoding: options.encoding ?? 'webp',
        },
        url,
        dataType,
      }),
    );

    emitNetToPlayer('screencapture:captureScreen', playerSource, token, options, dataType);
  },
);

global.exports(
  'serverCapture',
  (source: PlayerSource, options: CaptureOptions, callback: CallbackFn, dataType: DataType = 'base64') => {
    const playerSource = validatePlayerSource(source, 'serverCapture');
    if (!playerSource) return;

    const opts = {
      ...options,
      encoding: options.encoding ?? 'webp',
    };

    const token = uploadStore.addUpload(
      createRegularUploadData({
        callback,
        isRemote: false,
        remoteConfig: opts,
        dataType,
      }),
    );

    emitNetToPlayer('screencapture:captureScreen', playerSource, token, opts, dataType);
  },
);

// screenshot-basic backwards compatibility
function requestClientScreenshot(source: PlayerSource, options: CaptureOptions, callback: ScreenshotBasicCallbackFn) {
  const playerSource = validatePlayerSource(source, 'requestClientScreenshot');
  if (!playerSource) return;

  const opts = {
    ...options,
    encoding: options.encoding ?? 'webp',
  };

  const isBlob = options.fileName ? true : false;

  const token = uploadStore.addUpload(
    createScreenshotBasicUploadData({
      callback,
      isRemote: false,
      remoteConfig: opts,
      dataType: isBlob ? 'blob' : 'base64',
    }),
  );

  emitNetToPlayer('screencapture:captureScreen', playerSource, token, opts, isBlob ? 'blob' : 'base64');
}

global.exports(
  'requestClientScreenshot',
  (source: PlayerSource, options: CaptureOptions, callback: ScreenshotBasicCallbackFn) => {
    requestClientScreenshot(source, options, callback);
  },
);
exportHandler(
  'requestClientScreenshot',
  (source: PlayerSource, options: CaptureOptions, callback: ScreenshotBasicCallbackFn) => {
    requestClientScreenshot(source, options, callback);
  },
);
