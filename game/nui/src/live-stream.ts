import { captureSessionCoordinator } from './capture-session-coordinator';
import { GameMediaSource } from './game-media-source';
import {
  LiveStreamActions,
  LiveStreamStartRequest,
  LiveStreamStatus,
  LiveStreamStopRequest,
} from './types';

type SessionDescription = {
  type: 'answer' | 'offer';
  sdp: string;
};

type PublisherConnectResponse = {
  sessionDescription: SessionDescription;
};

const HEARTBEAT_INTERVAL = 15_000;
const MAX_RECONNECT_ATTEMPTS = 3;

export class LiveStreamPublisher {
  #gameMediaSource = new GameMediaSource();
  #request: LiveStreamStartRequest | null = null;
  #mediaStream: MediaStream | null = null;
  #peerConnection: RTCPeerConnection | null = null;
  #heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  #expiryTimeout: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  #indicator: HTMLDivElement | null = null;
  #reconnectAttempts = 0;
  #connectionGeneration = 0;
  #operationGeneration = 0;
  #stopping = false;

  start(): void {
    window.addEventListener('message', (event) => {
      const data = event.data as LiveStreamStartRequest | LiveStreamStopRequest;

      if (data.action === LiveStreamActions.Start) {
        void this.startPublishing(data);
      }

      if (data.action === LiveStreamActions.Stop) {
        if (data.streamId && this.#request?.streamId !== data.streamId) return;
        void this.stopPublishing();
      }
    });

    window.addEventListener('resize', () => {
      this.#gameMediaSource.resize();
    });
  }

  private async startPublishing(request: LiveStreamStartRequest): Promise<void> {
    if (this.#request || !captureSessionCoordinator.acquire('live', request.streamId)) {
      await this.sendStatus(request.statusCallbackUrl, {
        streamId: request.streamId,
        state: 'failed',
        audioAvailable: false,
        error: 'Another video capture session is already active',
      });
      return;
    }

    let endpoint: string;
    try {
      endpoint = this.normalizeEndpoint(request.endpoint);
    } catch (error) {
      captureSessionCoordinator.release('live', request.streamId);
      await this.sendStatus(request.statusCallbackUrl, {
        streamId: request.streamId,
        state: 'failed',
        audioAvailable: false,
        error: this.errorMessage(error),
      });
      return;
    }

    this.#request = {
      ...request,
      endpoint,
      frameRate: Math.min(Math.max(request.frameRate ?? 30, 1), 30),
    };
    const operationGeneration = ++this.#operationGeneration;
    this.#stopping = false;
    this.updateIndicator('connecting');
    await this.report('connecting');

    try {
      this.#mediaStream = await this.#gameMediaSource.start({
        maxWidth: Math.min(request.maxWidth ?? 1280, 1280),
        maxHeight: Math.min(request.maxHeight ?? 720, 720),
        frameRate: this.#request.frameRate,
      });
      if (operationGeneration !== this.#operationGeneration || this.#request?.streamId !== request.streamId) {
        return;
      }

      await this.connect();
      if (operationGeneration !== this.#operationGeneration || this.#request?.streamId !== request.streamId) {
        return;
      }

      const remainingLifetime = Math.max(0, request.expiresAt - Date.now());
      this.#expiryTimeout = setTimeout(() => {
        void this.stopPublishing();
      }, remainingLifetime);
    } catch (error) {
      if (operationGeneration !== this.#operationGeneration || this.#request?.streamId !== request.streamId) {
        return;
      }
      await this.report('failed', this.errorMessage(error));
      await this.stopPublishing(false);
    }
  }

  private async connect(): Promise<void> {
    const request = this.#request;
    const videoTrack = this.#mediaStream?.getVideoTracks()[0];
    if (!request || !videoTrack) throw new Error('Game video track is unavailable');

    const generation = ++this.#connectionGeneration;
    this.#peerConnection?.close();

    const peerConnection = new RTCPeerConnection({
      bundlePolicy: 'max-bundle',
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    });
    this.#peerConnection = peerConnection;

    const transceiver = peerConnection.addTransceiver(videoTrack, {
      direction: 'sendonly',
      sendEncodings: [
        { rid: 'a', scaleResolutionDownBy: 1, maxBitrate: 2_500_000, maxFramerate: request.frameRate },
        { rid: 'b', scaleResolutionDownBy: 2, maxBitrate: 1_200_000, maxFramerate: request.frameRate },
        { rid: 'c', scaleResolutionDownBy: 4, maxBitrate: 400_000, maxFramerate: 15 },
      ],
    });

    peerConnection.addEventListener('connectionstatechange', () => {
      if (generation === this.#connectionGeneration) void this.handleConnectionState();
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await this.waitForIceGathering(peerConnection);

    const localDescription = peerConnection.localDescription;
    if (!localDescription?.sdp || !transceiver.mid) {
      throw new Error('Could not create a publish offer');
    }

    const response = await this.requestJson<PublisherConnectResponse>(
      `${request.endpoint}/v1/streams/${encodeURIComponent(request.streamId)}/publisher/connect`,
      {
        method: 'POST',
        body: JSON.stringify({
          sessionDescription: { type: localDescription.type, sdp: localDescription.sdp },
          tracks: [{ location: 'local', mid: transceiver.mid, trackName: 'video' }],
          audioAvailable: false,
        }),
      },
    );

    if (!this.isSessionDescription(response.sessionDescription, 'answer')) {
      throw new Error('Signaling service returned an invalid publish answer');
    }

    await peerConnection.setRemoteDescription(response.sessionDescription);
  }

  private async handleConnectionState(): Promise<void> {
    const state = this.#peerConnection?.connectionState;
    if (!this.#request || this.#stopping) return;

    if (state === 'connected') {
      this.#reconnectAttempts = 0;
      this.startHeartbeat();
      this.updateIndicator('live');
      await this.report('live');
      return;
    }

    if (state !== 'failed' && state !== 'disconnected') return;
    await this.scheduleReconnect();
  }

  private async scheduleReconnect(error?: unknown): Promise<void> {
    if (!this.#request || this.#stopping || this.#reconnectTimeout) return;

    if (this.#reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      await this.report('failed', 'The live stream connection could not be restored');
      await this.stopPublishing(false);
      return;
    }

    this.stopHeartbeat();
    this.updateIndicator('reconnecting');
    await this.report('reconnecting', error ? this.errorMessage(error) : undefined);

    const delay = 1_000 * (2 ** this.#reconnectAttempts++);
    this.#reconnectTimeout = setTimeout(() => {
      this.#reconnectTimeout = null;
      void this.connect().catch((connectError) => this.scheduleReconnect(connectError));
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.#heartbeatInterval) return;

    this.#heartbeatInterval = setInterval(() => {
      const request = this.#request;
      if (!request) return;

      void this.requestJson(
        `${request.endpoint}/v1/streams/${encodeURIComponent(request.streamId)}/publisher/heartbeat`,
        {
          method: 'POST',
          body: JSON.stringify({ connectionState: this.#peerConnection?.connectionState }),
        },
      ).catch(() => {
        if (this.#peerConnection?.connectionState === 'connected') return;
        void this.handleConnectionState();
      });
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.#heartbeatInterval) clearInterval(this.#heartbeatInterval);
    this.#heartbeatInterval = null;
  }

  private async stopPublishing(reportStopped = true): Promise<void> {
    const request = this.#request;
    if (!request || this.#stopping) return;
    this.#stopping = true;
    this.#operationGeneration++;

    this.stopHeartbeat();
    if (this.#expiryTimeout) clearTimeout(this.#expiryTimeout);
    if (this.#reconnectTimeout) clearTimeout(this.#reconnectTimeout);
    this.#expiryTimeout = null;
    this.#reconnectTimeout = null;

    this.#peerConnection?.close();
    this.#peerConnection = null;
    this.#gameMediaSource.stop();
    this.#mediaStream = null;

    try {
      await this.requestJson(
        `${request.endpoint}/v1/streams/${encodeURIComponent(request.streamId)}/publisher`,
        { method: 'DELETE' },
      );
    } catch {
      // The server-side owner cleanup remains authoritative.
    }

    if (reportStopped) await this.report('stopped');

    this.#indicator?.remove();
    this.#indicator = null;
    captureSessionCoordinator.release('live', request.streamId);
    this.#request = null;
    this.#reconnectAttempts = 0;
    this.#stopping = false;
  }

  private async report(state: LiveStreamStatus['state'], error?: string): Promise<void> {
    const request = this.#request;
    if (!request) return;

    const settings = this.#mediaStream?.getVideoTracks()[0]?.getSettings();
    await this.sendStatus(request.statusCallbackUrl, {
      streamId: request.streamId,
      state,
      audioAvailable: false,
      width: settings?.width,
      height: settings?.height,
      frameRate: settings?.frameRate ?? request.frameRate,
      error,
    });
  }

  private async sendStatus(callbackUrl: string, status: LiveStreamStatus): Promise<void> {
    try {
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(status),
      });
    } catch (error) {
      console.error('[screencapture] failed to report live stream status:', this.errorMessage(error));
    }
  }

  private updateIndicator(state: 'connecting' | 'live' | 'reconnecting'): void {
    if (!this.#indicator) {
      this.#indicator = document.createElement('div');
      this.#indicator.className = 'live-stream-indicator';
      this.#indicator.setAttribute('role', 'status');
      this.#indicator.setAttribute('aria-live', 'polite');
      document.body.append(this.#indicator);
    }

    this.#indicator.dataset.state = state;
    this.#indicator.textContent = state === 'live'
      ? 'SCREEN LIVE / VIDEO ONLY'
      : state === 'reconnecting'
        ? 'SCREEN LIVE / RECONNECTING'
        : 'SCREEN LIVE / CONNECTING';
  }

  private normalizeEndpoint(endpoint: string): string {
    const url = new URL(endpoint);
    const isLocalDevelopment = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !isLocalDevelopment) {
      throw new Error('Live stream endpoint must use HTTPS');
    }
    return url.toString().replace(/\/$/, '');
  }

  private async requestJson<T = object>(url: string, init: RequestInit): Promise<T> {
    const request = this.#request;
    if (!request) throw new Error('Live stream is not active');

    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${request.publisherToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });

    const result = await response.json().catch(() => ({})) as { error?: string } & T;
    if (!response.ok) throw new Error(result.error ?? `Signaling request failed with status ${response.status}`);
    return result;
  }

  private waitForIceGathering(peerConnection: RTCPeerConnection): Promise<void> {
    if (peerConnection.iceGatheringState === 'complete') return Promise.resolve();

    return new Promise((resolve) => {
      const timeout = setTimeout(finish, 10_000);

      function finish(): void {
        clearTimeout(timeout);
        peerConnection.removeEventListener('icegatheringstatechange', handleStateChange);
        resolve();
      }

      function handleStateChange(): void {
        if (peerConnection.iceGatheringState === 'complete') finish();
      }

      peerConnection.addEventListener('icegatheringstatechange', handleStateChange);
    });
  }

  private isSessionDescription(value: unknown, type: SessionDescription['type']): value is SessionDescription {
    if (!value || typeof value !== 'object') return false;
    const description = value as Partial<SessionDescription>;
    return description.type === type && typeof description.sdp === 'string' && description.sdp.length > 0;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown live stream error';
  }
}