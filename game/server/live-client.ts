import fetch, { RequestInit } from 'node-fetch';

import { LiveStreamViewerGrant, ProvisionedLiveStream } from './types';

const REQUEST_TIMEOUT = 10_000;

export class LiveStreamClient {
  readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/$/, '');
  }

  async createStream(streamId: string, duration: number, maxViewers: number): Promise<ProvisionedLiveStream> {
    const response = await this.requestJson<ProvisionedLiveStream>('/v1/streams', {
      method: 'POST',
      body: JSON.stringify({ streamId, duration, maxViewers }),
    });

    if (
      response.streamId !== streamId
      || typeof response.ownerToken !== 'string'
      || typeof response.publisherToken !== 'string'
      || !Number.isFinite(response.expiresAt)
    ) {
      throw new Error('Live service returned an invalid stream grant');
    }

    return response;
  }

  async createViewerToken(streamId: string, ownerToken: string): Promise<LiveStreamViewerGrant> {
    const response = await this.requestJson<LiveStreamViewerGrant>(
      `/v1/streams/${encodeURIComponent(streamId)}/viewers`,
      { method: 'POST' },
      ownerToken,
    );

    if (
      response.streamId !== streamId
      || typeof response.viewerToken !== 'string'
      || !Number.isFinite(response.expiresAt)
    ) {
      throw new Error('Live service returned an invalid viewer grant');
    }

    return response;
  }

  async deleteStream(streamId: string, ownerToken: string): Promise<void> {
    await this.requestJson(
      `/v1/streams/${encodeURIComponent(streamId)}`,
      { method: 'DELETE' },
      ownerToken,
    );
  }

  private async requestJson<T = object>(path: string, init: RequestInit, token?: string): Promise<T> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        ...init,
        signal: abortController.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token && { Authorization: `Bearer ${token}` }),
          ...init.headers,
        },
      });

      const result = await response.json().catch(() => ({})) as { error?: string } & T;
      if (!response.ok) {
        throw new Error(result.error ?? `Live service request failed with status ${response.status}`);
      }

      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Live service request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}