import { SessionDescription, TracksRequest, TracksResponse } from './contracts';

type RealtimeEnvironment = {
  CALLS_APP_ID: string;
  CALLS_APP_SECRET: string;
};

type NewSessionResponse = {
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
};

const REALTIME_API = 'https://rtc.live.cloudflare.com/v1';
const REQUEST_TIMEOUT = 10_000;

export class RealtimeClient {
  constructor(private readonly env: RealtimeEnvironment) {}

  async createSession(): Promise<string> {
    const response = await this.request<NewSessionResponse>('/sessions/new', { method: 'POST' });
    if (!response.sessionId) throw new Error('Realtime did not return a session ID');
    return response.sessionId;
  }

  async addTracks(sessionId: string, request: TracksRequest): Promise<TracksResponse> {
    return this.request<TracksResponse>(`/sessions/${encodeURIComponent(sessionId)}/tracks/new`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async renegotiate(sessionId: string, sessionDescription: SessionDescription): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/renegotiate`, {
      method: 'PUT',
      body: JSON.stringify({ sessionDescription }),
    });
  }

  async updateTracks(sessionId: string, request: TracksRequest): Promise<TracksResponse> {
    return this.request<TracksResponse>(`/sessions/${encodeURIComponent(sessionId)}/tracks/update`, {
      method: 'PUT',
      body: JSON.stringify(request),
    });
  }

  async closeTracks(sessionId: string, mids: string[]): Promise<void> {
    if (!mids.length) return;

    await this.request(`/sessions/${encodeURIComponent(sessionId)}/tracks/close`, {
      method: 'PUT',
      body: JSON.stringify({
        force: true,
        tracks: mids.map((mid) => ({ mid })),
      }),
    });
  }

  private async request<T = object>(path: string, init: RequestInit): Promise<T> {
    if (!this.env.CALLS_APP_ID || this.env.CALLS_APP_ID === 'REPLACE_WITH_REALTIME_APP_ID') {
      throw new Error('Realtime App ID is not configured');
    }
    if (!this.env.CALLS_APP_SECRET) throw new Error('Realtime App Secret is not configured');

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(
        `${REALTIME_API}/apps/${encodeURIComponent(this.env.CALLS_APP_ID)}${path}`,
        {
          ...init,
          signal: abortController.signal,
          headers: {
            Authorization: `Bearer ${this.env.CALLS_APP_SECRET}`,
            'Content-Type': 'application/json',
            ...init.headers,
          },
        },
      );

      const result = await response.json() as T & { errorCode?: string; errorDescription?: string };
      if (!response.ok || result.errorCode) {
        throw new Error(result.errorDescription ?? `Realtime request failed with status ${response.status}`);
      }
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Realtime request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}