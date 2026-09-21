import { liveStreamStore } from './bootstrap';
import { LiveStreamClient } from './live-client';
import { LiveStreamOptions, LiveStreamStatus } from './types';
import { emitNetToPlayer } from './net';

type LiveStreamEndReason = 'manual' | 'duration' | 'player-dropped' | 'publisher-failed' | 'publisher-stopped' | 'resource-stop';

let liveStreamClient: LiveStreamClient | null = null;
let configuredEndpoint = '';

export function getLiveStreamClient(): LiveStreamClient {
  const endpoint = GetConvar('screencapture_live_endpoint', '').trim();
  if (!endpoint) {
    throw new Error('screencapture_live_endpoint is not configured');
  }

  const url = new URL(endpoint);
  const isLocalDevelopment = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocalDevelopment) {
    throw new Error('screencapture_live_endpoint must use HTTPS');
  }

  const normalizedEndpoint = url.toString().replace(/\/$/, '');
  if (!liveStreamClient || configuredEndpoint !== normalizedEndpoint) {
    configuredEndpoint = normalizedEndpoint;
    liveStreamClient = new LiveStreamClient(normalizedEndpoint);
  }

  return liveStreamClient;
}

export async function provisionLiveStream(
  streamId: string,
  source: number,
  options: Required<LiveStreamOptions>,
): Promise<void> {
  try {
    const client = getLiveStreamClient();
    const grant = await client.createStream(streamId, options.duration, options.maxViewers);

    if (!liveStreamStore.has(streamId)) {
      await client.deleteStream(streamId, grant.ownerToken).catch(() => undefined);
      return;
    }

    liveStreamStore.provision(streamId, grant.ownerToken, grant.publisherToken, grant.expiresAt);
    liveStreamStore.setExpiryTimeout(streamId, setTimeout(() => {
      void endLiveStream(streamId, 'duration');
    }, Math.max(0, grant.expiresAt - Date.now())));

    emitNetToPlayer('screencapture:liveStream:start', source, {
      endpoint: client.endpoint,
      streamId,
      publisherToken: grant.publisherToken,
      expiresAt: grant.expiresAt,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      frameRate: options.frameRate,
    });
  } catch (error) {
    const message = errorMessage(error);
    liveStreamStore.resolveError(streamId, message);
    liveStreamStore.remove(streamId);
    emit('screencapture:liveStreamEnded', streamId, source, 'publisher-failed', message);
  }
}

export async function endLiveStream(streamId: string, reason: LiveStreamEndReason): Promise<boolean> {
  if (!liveStreamStore.has(streamId)) return false;

  const entry = liveStreamStore.get(streamId);
  if (!entry.callbackResolved) {
    liveStreamStore.resolveError(streamId, `Live stream ended before it became ready: ${reason}`);
  }
  liveStreamStore.remove(streamId);

  emitNetToPlayer('screencapture:liveStream:stop', entry.source, streamId);

  if (entry.ownerToken) {
    try {
      await getLiveStreamClient().deleteStream(streamId, entry.ownerToken);
    } catch (error) {
      console.error(`[screencapture] failed to clean up live stream ${streamId}: ${errorMessage(error)}`);
    }
  }

  emit('screencapture:liveStreamEnded', streamId, entry.source, reason, entry.error);
  return true;
}

function isLiveStreamStatus(value: unknown): value is LiveStreamStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<LiveStreamStatus>;
  return typeof status.streamId === 'string'
    && ['connecting', 'live', 'reconnecting', 'failed', 'stopped'].includes(status.state ?? '')
    && typeof status.audioAvailable === 'boolean';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown live stream error';
}

export function registerLiveStreamHandlers(): void {
  onNet('screencapture:liveStream:status', (status: unknown) => {
    const source = global.source;
    if (!isLiveStreamStatus(status) || !liveStreamStore.has(status.streamId)) return;

    const entry = liveStreamStore.get(status.streamId);
    if (entry.source !== source) return;

    liveStreamStore.updateStatus(status.streamId, status);

    if (status.state === 'live') {
      liveStreamStore.resolveReady(status.streamId);
    } else if (status.state === 'failed') {
      void endLiveStream(status.streamId, 'publisher-failed');
    } else if (status.state === 'stopped') {
      void endLiveStream(status.streamId, 'publisher-stopped');
    }
  });

  on('playerDropped', () => {
    const entry = liveStreamStore.getBySource(global.source);
    if (entry) void endLiveStream(entry.streamId, 'player-dropped');
  });

  on('onResourceStop', (resourceName: string) => {
    if (resourceName !== GetCurrentResourceName()) return;
    for (const entry of liveStreamStore.entries()) {
      void endLiveStream(entry.streamId, 'resource-stop');
    }
  });
}