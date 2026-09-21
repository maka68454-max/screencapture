import {
  LiveStreamCallback,
  LiveStreamEntry,
  LiveStreamReadyResult,
  LiveStreamStatus,
} from './types';

export class LiveStreamStore {
  #streams = new Map<string, LiveStreamEntry>();
  #sourceToStreamId = new Map<number, string>();

  addPending(streamId: string, source: number, callback: LiveStreamCallback): LiveStreamEntry {
    if (this.#sourceToStreamId.has(source)) {
      throw new Error(`Source ${source} already has an active live stream`);
    }

    const entry: LiveStreamEntry = {
      streamId,
      source,
      state: 'provisioning',
      callback,
      callbackResolved: false,
      audioAvailable: false,
      createdAt: Date.now(),
    };

    this.#streams.set(streamId, entry);
    this.#sourceToStreamId.set(source, streamId);
    return entry;
  }

  provision(streamId: string, ownerToken: string, publisherToken: string, expiresAt: number): LiveStreamEntry {
    const entry = this.get(streamId);
    entry.ownerToken = ownerToken;
    entry.publisherToken = publisherToken;
    entry.expiresAt = expiresAt;
    entry.state = 'connecting';
    return entry;
  }

  updateStatus(streamId: string, status: LiveStreamStatus): LiveStreamEntry {
    const entry = this.get(streamId);
    entry.state = status.state;
    entry.audioAvailable = status.audioAvailable;
    entry.width = status.width;
    entry.height = status.height;
    entry.frameRate = status.frameRate;
    entry.error = status.error;
    return entry;
  }

  resolveReady(streamId: string): void {
    const entry = this.get(streamId);
    if (entry.callbackResolved || !entry.expiresAt) return;

    const result: LiveStreamReadyResult = {
      streamId: entry.streamId,
      source: entry.source,
      status: 'ready',
      expiresAt: entry.expiresAt,
      audioAvailable: entry.audioAvailable,
      width: entry.width,
      height: entry.height,
      frameRate: entry.frameRate,
    };

    entry.callbackResolved = true;
    entry.callback(result);
  }

  resolveError(streamId: string, error: string): void {
    const entry = this.#streams.get(streamId);
    if (!entry || entry.callbackResolved) return;

    entry.callbackResolved = true;
    entry.callback({
      streamId: entry.streamId,
      source: entry.source,
      status: 'error',
      error,
    });
  }

  setExpiryTimeout(streamId: string, timeout: ReturnType<typeof setTimeout>): void {
    const entry = this.get(streamId);
    if (entry.expiryTimeout) clearTimeout(entry.expiryTimeout);
    entry.expiryTimeout = timeout;
  }

  get(streamId: string): LiveStreamEntry {
    const entry = this.#streams.get(streamId);
    if (!entry) throw new Error(`Live stream ${streamId} was not found`);
    return entry;
  }

  getBySource(source: number): LiveStreamEntry | undefined {
    const streamId = this.#sourceToStreamId.get(source);
    return streamId ? this.#streams.get(streamId) : undefined;
  }

  has(streamId: string): boolean {
    return this.#streams.has(streamId);
  }

  hasActiveStreamForSource(source: number): boolean {
    return this.#sourceToStreamId.has(source);
  }

  remove(streamId: string): LiveStreamEntry | undefined {
    const entry = this.#streams.get(streamId);
    if (!entry) return undefined;

    if (entry.expiryTimeout) clearTimeout(entry.expiryTimeout);
    this.#sourceToStreamId.delete(entry.source);
    this.#streams.delete(streamId);
    return entry;
  }

  entries(): LiveStreamEntry[] {
    return [...this.#streams.values()];
  }
}