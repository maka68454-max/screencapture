import { DurableObject } from 'cloudflare:workers';

import {
  CreateStreamInput,
  PublisherConnectInput,
  PublisherConnectResult,
  RealtimeTrack,
  RoomResult,
  SessionDescription,
  ViewerConnectResult,
  ViewerTokenResult,
} from './contracts';
import { RealtimeClient } from './realtime';

type StreamRow = {
  stream_id: string;
  expires_at: number;
  max_viewers: number;
  owner_hash: string;
  publisher_hash: string;
  status: 'created' | 'publishing' | 'live' | 'ending' | 'ended' | 'expired';
  publisher_session_id: string | null;
  publisher_mids: string;
  video_track_name: string | null;
  audio_track_name: string | null;
  updated_at: number;
};

type ViewerRow = {
  viewer_id: string;
  grant_hash: string;
  session_hash: string | null;
  expires_at: number;
  redeemed: number;
  sfu_session_id: string | null;
  mids: string;
  video_mid: string | null;
  audio_mid: string | null;
  last_seen: number | null;
};

const VIEWER_GRANT_LIFETIME = 60_000;
const VIEWER_LEASE_LIFETIME = 45_000;
const PUBLISHER_LEASE_LIFETIME = 45_000;

export class LiveStreamRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS stream_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          stream_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          max_viewers INTEGER NOT NULL,
          owner_hash TEXT NOT NULL,
          publisher_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          publisher_session_id TEXT,
          publisher_mids TEXT NOT NULL DEFAULT '[]',
          video_track_name TEXT,
          audio_track_name TEXT,
          updated_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS viewers (
          viewer_id TEXT PRIMARY KEY,
          grant_hash TEXT UNIQUE NOT NULL,
          session_hash TEXT,
          expires_at INTEGER NOT NULL,
          redeemed INTEGER NOT NULL DEFAULT 0,
          sfu_session_id TEXT,
          mids TEXT NOT NULL DEFAULT '[]',
          video_mid TEXT,
          audio_mid TEXT,
          last_seen INTEGER
        )
      `);
    });
  }

  async create(input: CreateStreamInput): Promise<RoomResult<{ expiresAt: number }>> {
    const existing = this.getStream();
    if (existing && existing.status !== 'ended' && existing.status !== 'expired' && existing.expires_at > Date.now()) {
      return failure(409, 'Stream already exists');
    }

    const expiresAt = Date.now() + input.duration * 1000;
    const [ownerHash, publisherHash] = await Promise.all([
      hashToken(input.ownerToken),
      hashToken(input.publisherToken),
    ]);

    this.ctx.storage.sql.exec('DELETE FROM viewers');
    this.ctx.storage.sql.exec('DELETE FROM stream_state');
    this.ctx.storage.sql.exec(
      `INSERT INTO stream_state (
        singleton, stream_id, expires_at, max_viewers, owner_hash, publisher_hash, status, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, 'created', ?)`,
      input.streamId,
      expiresAt,
      input.maxViewers,
      ownerHash,
      publisherHash,
      Date.now(),
    );
    this.scheduleNextAlarm(this.getStream()!);

    return success({ expiresAt });
  }

  async connectPublisher(
    publisherToken: string,
    input: PublisherConnectInput,
  ): Promise<RoomResult<PublisherConnectResult>> {
    const stream = this.getStream();
    if (!stream) return failure(401, 'Invalid publisher capability');
    const authorized = await this.authorize(stream, publisherToken, 'publisher');
    if (!authorized.ok) return authorized;
    const currentStream = this.getStream();
    if (!currentStream || currentStream.status === 'publishing') {
      return failure(409, 'Publisher negotiation is already in progress');
    }
    if (currentStream.status !== 'created' && currentStream.status !== 'live') {
      return failure(410, 'Stream has ended');
    }
    if (!isSessionDescription(input.sessionDescription, 'offer')) return failure(400, 'Invalid publish offer');

    const tracks = input.tracks.filter(isLocalPublishTrack);
    if (!tracks.length || tracks.length > 2 || !tracks.some((track) => track.trackName === 'video')) {
      return failure(400, 'A video publish track is required');
    }

    const realtime = new RealtimeClient(this.env);
    const oldPublisher = currentStream.publisher_session_id ? currentStream : null;
    this.ctx.storage.sql.exec(
      `UPDATE stream_state SET status = 'publishing', updated_at = ?
       WHERE singleton = 1 AND status IN ('created', 'live')`,
      Date.now(),
    );

    let newSessionId: string | null = null;
    let newMids: string[] = [];
    const retargetedViewers: ViewerRow[] = [];
    try {
      newSessionId = await realtime.createSession();
      const response = await realtime.addTracks(newSessionId, {
        sessionDescription: input.sessionDescription,
        tracks,
      });

      if (!isSessionDescription(response.sessionDescription, 'answer')) {
        throw new Error('Media service returned an invalid publish answer');
      }

      const requiredTrackNames = input.audioAvailable ? ['video', 'audio'] : ['video'];
      newMids = (response.tracks ?? []).flatMap((track) => track.mid ? [track.mid] : []);
      const publishedTracks = requireSuccessfulTracks(response.tracks, requiredTrackNames);
      const videoTrack = publishedTracks.find((track) => track.trackName === 'video');
      const audioTrack = publishedTracks.find((track) => track.trackName === 'audio');
      if (!videoTrack?.mid) throw new Error('Media service did not publish the video track');

      const current = this.getStream();
      if (!current || current.status !== 'publishing') throw new Error('Stream ended during publisher negotiation');

      const viewers = this.ctx.storage.sql.exec<ViewerRow>(
        'SELECT * FROM viewers WHERE redeemed = 1 AND sfu_session_id IS NOT NULL',
      ).toArray();
      for (const viewer of viewers) {
        await this.retargetViewer(realtime, viewer, newSessionId, videoTrack.trackName, audioTrack?.trackName ?? null);
        retargetedViewers.push(viewer);
      }

      this.ctx.storage.sql.exec(
        `UPDATE stream_state SET
          status = 'live', publisher_session_id = ?, publisher_mids = ?,
          video_track_name = ?, audio_track_name = ?, updated_at = ?
        WHERE singleton = 1 AND status = 'publishing'`,
        newSessionId,
        JSON.stringify(newMids),
        videoTrack.trackName,
        input.audioAvailable ? (audioTrack?.trackName ?? null) : null,
        Date.now(),
      );

      const committed = this.getStream();
      if (committed?.status !== 'live' || committed.publisher_session_id !== newSessionId) {
        throw new Error('Stream ended during publisher replacement');
      }
      this.scheduleNextAlarm(committed);

      if (oldPublisher) await this.closePublisher(realtime, oldPublisher);

      return success({ sessionDescription: response.sessionDescription });
    } catch {
      if (oldPublisher) {
        await Promise.allSettled(retargetedViewers.map((viewer) => this.retargetViewer(
          realtime,
          viewer,
          oldPublisher.publisher_session_id!,
          oldPublisher.video_track_name!,
          oldPublisher.audio_track_name,
        )));
      }
      if (newSessionId) await realtime.closeTracks(newSessionId, newMids).catch(() => undefined);

      const current = this.getStream();
      if (current?.status === 'publishing') {
        this.ctx.storage.sql.exec(
          `UPDATE stream_state SET status = ?, updated_at = ? WHERE singleton = 1 AND status = 'publishing'`,
          oldPublisher ? 'live' : 'created',
          Date.now(),
        );
      }
      return failure(502, 'Media service could not publish the stream');
    }
  }

  async heartbeatPublisher(publisherToken: string): Promise<RoomResult<{ expiresAt: number }>> {
    const stream = this.getStream();
    if (!stream) return failure(401, 'Invalid publisher capability');
    const authorized = await this.authorize(stream, publisherToken, 'publisher');
    if (!authorized.ok) return authorized;

    this.ctx.storage.sql.exec('UPDATE stream_state SET updated_at = ? WHERE singleton = 1', Date.now());
    this.scheduleNextAlarm({ ...stream, updated_at: Date.now() });
    return success({ expiresAt: stream.expires_at });
  }

  async stopPublisher(publisherToken: string): Promise<RoomResult<object>> {
    const stream = this.getStream();
    if (!stream) return failure(401, 'Invalid publisher capability');
    const authorized = await this.authorize(stream, publisherToken, 'publisher');
    if (!authorized.ok) return authorized;

    await this.cleanup('ended');
    return success({});
  }

  async createViewerToken(ownerToken: string): Promise<RoomResult<ViewerTokenResult>> {
    const initialStream = this.getStream();
    if (!initialStream) return failure(401, 'Invalid owner capability');
    const authorized = await this.authorize(initialStream, ownerToken, 'owner');
    if (!authorized.ok) return authorized;

    await this.reapViewerLeases();

    const stream = this.getStream();
    if (stream?.status !== 'live' || !stream.publisher_session_id || !stream.video_track_name) {
      return failure(409, 'Publisher is not ready');
    }
    if (this.activeViewerCount() >= stream.max_viewers) return failure(429, 'Viewer limit reached');

    const viewerId = crypto.randomUUID();
    const viewerToken = createToken();
    const expiresAt = Math.min(stream.expires_at, Date.now() + VIEWER_GRANT_LIFETIME);
    const grantHash = await hashToken(viewerToken);

    this.ctx.storage.sql.exec(
      `INSERT INTO viewers (viewer_id, grant_hash, expires_at, redeemed, mids)
       VALUES (?, ?, ?, 0, '[]')`,
      viewerId,
      grantHash,
      expiresAt,
    );
    this.scheduleNextAlarm(stream);

    return success({ streamId: stream.stream_id, viewerToken, expiresAt });
  }

  async connectViewer(viewerToken: string): Promise<RoomResult<ViewerConnectResult>> {
    const grantHash = await hashToken(viewerToken);
    const viewerSessionToken = createToken();
    const sessionHash = await hashToken(viewerSessionToken);

    await this.reapViewerLeases();

    const viewer = this.getViewerByGrantHash(grantHash);
    const stream = this.getStream();
    if (!viewer) return failure(401, 'Invalid viewer capability');
    if (!stream || stream.expires_at <= Date.now() || stream.status !== 'live') return failure(410, 'Stream has ended');
    if (viewer.expires_at <= Date.now()) return failure(410, 'Viewer capability expired');
    if (viewer.redeemed) return failure(409, 'Viewer capability was already used');

    if (this.activeViewerCount() >= stream.max_viewers) return failure(429, 'Viewer limit reached');

    this.ctx.storage.sql.exec(
      `UPDATE viewers SET redeemed = 1, session_hash = ?, expires_at = ?, last_seen = ?
       WHERE viewer_id = ? AND redeemed = 0`,
      sessionHash,
      stream.expires_at,
      Date.now(),
      viewer.viewer_id,
    );

    const result = await this.createViewerSession(stream, { ...viewer, redeemed: 1, session_hash: sessionHash }, viewerSessionToken);
    if (!result.ok) this.ctx.storage.sql.exec('DELETE FROM viewers WHERE viewer_id = ?', viewer.viewer_id);
    return result;
  }

  async answerViewer(
    viewerId: string,
    viewerSessionToken: string,
    sessionDescription: SessionDescription,
  ): Promise<RoomResult<object>> {
    if (!isSessionDescription(sessionDescription, 'answer')) return failure(400, 'Invalid viewer answer');

    const viewer = this.getViewer(viewerId);
    const authorized = await this.authorizeViewer(viewer, viewerSessionToken);
    if (!authorized.ok) return authorized;
    if (!viewer?.sfu_session_id) return failure(409, 'Viewer session is not connected');

    try {
      await new RealtimeClient(this.env).renegotiate(viewer.sfu_session_id, sessionDescription);
      this.touchViewer(viewerId);
      return success({});
    } catch {
      return failure(502, 'Media service could not complete viewer negotiation');
    }
  }

  async heartbeatViewer(viewerId: string, viewerSessionToken: string): Promise<RoomResult<{ expiresAt: number }>> {
    const viewer = this.getViewer(viewerId);
    const authorized = await this.authorizeViewer(viewer, viewerSessionToken);
    if (!authorized.ok) return authorized;

    const stream = this.getStream();
    if (!stream || stream.expires_at <= Date.now()) return failure(410, 'Stream has ended');
    this.touchViewer(viewerId);
    this.scheduleNextAlarm(stream);
    return success({ expiresAt: stream.expires_at });
  }

  async setViewerQuality(
    viewerId: string,
    viewerSessionToken: string,
    quality: 'auto' | 'high' | 'medium' | 'low',
  ): Promise<RoomResult<object>> {
    const viewer = this.getViewer(viewerId);
    const authorized = await this.authorizeViewer(viewer, viewerSessionToken);
    if (!authorized.ok) return authorized;

    const stream = this.getStream();
    if (!viewer?.sfu_session_id || !viewer.video_mid || !stream?.publisher_session_id || !stream.video_track_name) {
      return failure(409, 'Viewer video track is not ready');
    }

    const preferredRid = quality === 'medium' ? 'b' : quality === 'low' ? 'c' : 'a';
    const automatic = quality === 'auto';

    try {
      const response = await new RealtimeClient(this.env).updateTracks(viewer.sfu_session_id, {
        tracks: [{
          location: 'remote',
          sessionId: stream.publisher_session_id,
          trackName: stream.video_track_name,
          mid: viewer.video_mid,
          simulcast: {
            preferredRid,
            priorityOrdering: automatic ? 'asciibetical' : 'none',
            ridNotAvailable: 'asciibetical',
          },
        }],
      });
      requireSuccessfulTracks(response.tracks, [stream.video_track_name]);
      this.touchViewer(viewerId);
      return success({});
    } catch {
      return failure(502, 'Media service could not update viewer quality');
    }
  }

  async reconnectViewer(viewerId: string, viewerSessionToken: string): Promise<RoomResult<ViewerConnectResult>> {
    const initialViewer = this.getViewer(viewerId);
    const authorized = await this.authorizeViewer(initialViewer, viewerSessionToken);
    if (!authorized.ok) return authorized;

    const replacementToken = createToken();
    const replacementHash = await hashToken(replacementToken);
    const viewer = this.getViewer(viewerId);
    const stillAuthorized = await this.authorizeViewer(viewer, viewerSessionToken);
    if (!stillAuthorized.ok) return stillAuthorized;

    const stream = this.getStream();
    if (!viewer || !stream || stream.status !== 'live' || stream.expires_at <= Date.now()) {
      return failure(410, 'Stream has ended');
    }

    this.ctx.storage.sql.exec(
      'UPDATE viewers SET session_hash = ?, last_seen = ? WHERE viewer_id = ?',
      replacementHash,
      Date.now(),
      viewerId,
    );

    const result = await this.createViewerSession(
      stream,
      { ...viewer, session_hash: replacementHash },
      replacementToken,
    );
    if (result.ok) {
      await this.closeViewer(new RealtimeClient(this.env), viewer);
    } else {
      const currentViewer = this.getViewer(viewerId);
      if (currentViewer?.session_hash === replacementHash) {
        this.ctx.storage.sql.exec(
          'UPDATE viewers SET session_hash = ?, last_seen = ? WHERE viewer_id = ?',
          viewer.session_hash,
          Date.now(),
          viewerId,
        );
      }
    }
    return result;
  }

  async disconnectViewer(viewerId: string, viewerSessionToken: string): Promise<RoomResult<object>> {
    const viewer = this.getViewer(viewerId);
    const authorized = await this.authorizeViewer(viewer, viewerSessionToken);
    if (!authorized.ok) return authorized;

    if (viewer) await this.closeViewer(new RealtimeClient(this.env), viewer);
    this.ctx.storage.sql.exec('DELETE FROM viewers WHERE viewer_id = ?', viewerId);
    const stream = this.getStream();
    if (stream) this.scheduleNextAlarm(stream);
    return success({});
  }

  async delete(ownerToken: string): Promise<RoomResult<object>> {
    const stream = this.getStream();
    if (!stream || !(await tokenMatches(ownerToken, stream.owner_hash))) {
      return failure(401, 'Invalid owner capability');
    }
    if (stream.status === 'ending' || stream.status === 'ended' || stream.status === 'expired') return success({});

    await this.cleanup('ended');
    return success({});
  }

  async alarm(): Promise<void> {
    const stream = this.getStream();
    if (!stream) return;

    if (stream.expires_at <= Date.now()) {
      await this.cleanup('expired');
      return;
    }

    if (
      (stream.status === 'created' || stream.status === 'publishing' || stream.status === 'live')
      && stream.updated_at + PUBLISHER_LEASE_LIFETIME <= Date.now()
    ) {
      await this.cleanup('expired');
      return;
    }

    await this.reapViewerLeases();
    this.scheduleNextAlarm(stream);
  }

  private async createViewerSession(
    stream: StreamRow,
    viewer: ViewerRow,
    viewerSessionToken: string,
  ): Promise<RoomResult<ViewerConnectResult>> {
    if (!stream.publisher_session_id || !stream.video_track_name) return failure(409, 'Publisher is not ready');

    const remoteTracks: RealtimeTrack[] = [{
      location: 'remote',
      sessionId: stream.publisher_session_id,
      trackName: stream.video_track_name,
      simulcast: {
        preferredRid: 'a',
        priorityOrdering: 'asciibetical',
        ridNotAvailable: 'asciibetical',
      },
    }];
    if (stream.audio_track_name) {
      remoteTracks.push({
        location: 'remote',
        sessionId: stream.publisher_session_id,
        trackName: stream.audio_track_name,
      });
    }

    const realtime = new RealtimeClient(this.env);
    let sessionId: string | null = null;
    let mids: string[] = [];
    try {
      sessionId = await realtime.createSession();
      const response = await realtime.addTracks(sessionId, { tracks: remoteTracks });
      if (!response.requiresImmediateRenegotiation || !isSessionDescription(response.sessionDescription, 'offer')) {
        throw new Error('Media service returned an invalid viewer offer');
      }

      mids = (response.tracks ?? []).flatMap((track) => track.mid ? [track.mid] : []);
      const pulledTracks = requireSuccessfulTracks(
        response.tracks,
        stream.audio_track_name ? [stream.video_track_name, stream.audio_track_name] : [stream.video_track_name],
      );
      const videoMid = pulledTracks.find((track) => track.trackName === stream.video_track_name)?.mid ?? null;
      const audioMid = stream.audio_track_name
        ? pulledTracks.find((track) => track.trackName === stream.audio_track_name)?.mid ?? null
        : null;
      if (!videoMid) throw new Error('Media service did not return a viewer video track');

      const currentViewer = this.getViewer(viewer.viewer_id);
      const currentStream = this.getStream();
      if (
        !currentViewer
        || currentViewer.session_hash !== viewer.session_hash
        || currentStream?.status !== 'live'
        || currentStream.publisher_session_id !== stream.publisher_session_id
      ) {
        await realtime.closeTracks(sessionId, mids).catch(() => undefined);
        return failure(410, 'Stream changed during viewer negotiation');
      }

      this.ctx.storage.sql.exec(
        `UPDATE viewers SET sfu_session_id = ?, mids = ?, video_mid = ?, audio_mid = ?, last_seen = ?
         WHERE viewer_id = ?`,
        sessionId,
        JSON.stringify(mids),
        videoMid,
        audioMid,
        Date.now(),
        viewer.viewer_id,
      );
      this.scheduleNextAlarm(stream);

      return success({
        viewerId: viewer.viewer_id,
        viewerSessionToken,
        expiresAt: stream.expires_at,
        sessionDescription: response.sessionDescription,
      });
    } catch {
      if (sessionId) await realtime.closeTracks(sessionId, mids).catch(() => undefined);
      return failure(502, 'Media service could not connect the viewer');
    }
  }

  private async retargetViewer(
    realtime: RealtimeClient,
    viewer: ViewerRow,
    publisherSessionId: string,
    videoTrackName: string,
    audioTrackName: string | null,
  ): Promise<void> {
    if (!viewer.sfu_session_id || !viewer.video_mid) return;

    const tracks: RealtimeTrack[] = [{
      location: 'remote',
      sessionId: publisherSessionId,
      trackName: videoTrackName,
      mid: viewer.video_mid,
      simulcast: {
        preferredRid: 'a',
        priorityOrdering: 'asciibetical',
        ridNotAvailable: 'asciibetical',
      },
    }];
    if (audioTrackName && viewer.audio_mid) {
      tracks.push({
        location: 'remote',
        sessionId: publisherSessionId,
        trackName: audioTrackName,
        mid: viewer.audio_mid,
      });
    }

    const response = await realtime.updateTracks(viewer.sfu_session_id, { tracks });
    requireSuccessfulTracks(response.tracks, tracks.map((track) => track.trackName));
  }

  private async authorize(
    stream: StreamRow | undefined,
    token: string,
    role: 'owner' | 'publisher',
  ): Promise<RoomResult<never>> {
    if (!stream || !(await tokenMatches(token, role === 'owner' ? stream.owner_hash : stream.publisher_hash))) {
      return failure(401, `Invalid ${role} capability`);
    }
    if (
      stream.expires_at <= Date.now()
      || stream.status === 'ending'
      || stream.status === 'ended'
      || stream.status === 'expired'
    ) {
      return failure(410, 'Stream has ended');
    }
    return { ok: true, value: undefined as never };
  }

  private async authorizeViewer(
    viewer: ViewerRow | undefined,
    token: string,
  ): Promise<RoomResult<never>> {
    if (!viewer?.session_hash || !(await tokenMatches(token, viewer.session_hash))) {
      return failure(401, 'Invalid viewer session capability');
    }
    return { ok: true, value: undefined as never };
  }

  private getStream(): StreamRow | undefined {
    return this.ctx.storage.sql.exec<StreamRow>('SELECT * FROM stream_state WHERE singleton = 1').toArray()[0];
  }

  private getViewer(viewerId: string): ViewerRow | undefined {
    return this.ctx.storage.sql.exec<ViewerRow>('SELECT * FROM viewers WHERE viewer_id = ?', viewerId).toArray()[0];
  }

  private getViewerByGrantHash(grantHash: string): ViewerRow | undefined {
    return this.ctx.storage.sql.exec<ViewerRow>('SELECT * FROM viewers WHERE grant_hash = ?', grantHash).toArray()[0];
  }

  private activeViewerCount(): number {
    const result = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM viewers WHERE redeemed = 1 AND last_seen >= ?',
      Date.now() - VIEWER_LEASE_LIFETIME,
    ).one();
    return result.count;
  }

  private async reapViewerLeases(): Promise<void> {
    const expiredViewers = this.ctx.storage.sql.exec<ViewerRow>(
      'SELECT * FROM viewers WHERE expires_at < ? OR (redeemed = 1 AND last_seen < ?)',
      Date.now(),
      Date.now() - VIEWER_LEASE_LIFETIME,
    ).toArray();
    if (!expiredViewers.length) return;

    const realtime = new RealtimeClient(this.env);
    await Promise.allSettled(expiredViewers.map((viewer) => this.closeViewer(realtime, viewer)));
    for (const viewer of expiredViewers) {
      this.ctx.storage.sql.exec('DELETE FROM viewers WHERE viewer_id = ?', viewer.viewer_id);
    }
  }

  private scheduleNextAlarm(stream: StreamRow): void {
    const viewerAlarm = this.ctx.storage.sql.exec<{ next_alarm: number | null }>(
      `SELECT MIN(
        CASE
          WHEN redeemed = 1 AND last_seen IS NOT NULL THEN MIN(expires_at, last_seen + ?)
          ELSE expires_at
        END
      ) AS next_alarm FROM viewers`,
      VIEWER_LEASE_LIFETIME,
    ).one().next_alarm;

    const publisherAlarm = stream.status === 'created' || stream.status === 'publishing' || stream.status === 'live'
      ? stream.updated_at + PUBLISHER_LEASE_LIFETIME
      : stream.expires_at;
    const nextAlarm = Math.min(stream.expires_at, publisherAlarm, viewerAlarm ?? stream.expires_at);
    this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, nextAlarm));
  }

  private touchViewer(viewerId: string): void {
    this.ctx.storage.sql.exec('UPDATE viewers SET last_seen = ? WHERE viewer_id = ?', Date.now(), viewerId);
  }

  private async closePublisher(realtime: RealtimeClient, stream: StreamRow): Promise<void> {
    if (!stream.publisher_session_id) return;
    await realtime.closeTracks(stream.publisher_session_id, parseMids(stream.publisher_mids)).catch(() => undefined);
  }

  private async closeViewer(realtime: RealtimeClient, viewer: ViewerRow): Promise<void> {
    if (!viewer.sfu_session_id) return;
    await realtime.closeTracks(viewer.sfu_session_id, parseMids(viewer.mids)).catch(() => undefined);
  }

  private async cleanup(status: 'ended' | 'expired'): Promise<void> {
    const stream = this.getStream();
    if (!stream || stream.status === 'ending' || stream.status === 'ended' || stream.status === 'expired') return;

    this.ctx.storage.sql.exec(
      `UPDATE stream_state SET status = 'ending', updated_at = ? WHERE singleton = 1`,
      Date.now(),
    );

    const realtime = new RealtimeClient(this.env);
    const viewers = this.ctx.storage.sql.exec<ViewerRow>('SELECT * FROM viewers WHERE sfu_session_id IS NOT NULL').toArray();
    await Promise.allSettled([
      this.closePublisher(realtime, stream),
      ...viewers.map((viewer) => this.closeViewer(realtime, viewer)),
    ]);

    this.ctx.storage.sql.exec('DELETE FROM viewers');
    this.ctx.storage.sql.exec(
      `UPDATE stream_state SET status = ?, publisher_session_id = NULL, publisher_mids = '[]',
       video_track_name = NULL, audio_track_name = NULL, updated_at = ? WHERE singleton = 1`,
      status,
      Date.now(),
    );
    this.ctx.storage.deleteAlarm();
  }
}

function success<T>(value: T): RoomResult<T> {
  return { ok: true, value };
}

function failure<T = never>(status: number, error: string): RoomResult<T> {
  return { ok: false, status, error };
}

function isSessionDescription(value: unknown, type: SessionDescription['type']): value is SessionDescription {
  if (!value || typeof value !== 'object') return false;
  const description = value as Partial<SessionDescription>;
  return description.type === type && typeof description.sdp === 'string' && description.sdp.length > 0;
}

function isLocalPublishTrack(track: RealtimeTrack): boolean {
  return track.location === 'local'
    && typeof track.mid === 'string'
    && (track.trackName === 'video' || track.trackName === 'audio');
}

function parseMids(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((mid): mid is string => typeof mid === 'string') : [];
  } catch {
    return [];
  }
}

function createToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function tokenMatches(token: string, expectedHash: string): Promise<boolean> {
  const actualHash = await hashToken(token);
  let difference = actualHash.length ^ expectedHash.length;
  const length = Math.max(actualHash.length, expectedHash.length);
  for (let index = 0; index < length; index++) {
    difference |= (actualHash.charCodeAt(index) || 0) ^ (expectedHash.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function requireSuccessfulTracks(tracks: RealtimeTrack[] | undefined, requiredTrackNames: string[]): RealtimeTrack[] {
  if (!tracks?.length) throw new Error('Media service did not return track results');

  for (const trackName of requiredTrackNames) {
    const track = tracks.find((candidate) => candidate.trackName === trackName);
    if (!track || track.errorCode || !track.mid) {
      throw new Error(track?.errorDescription ?? `Media service failed to configure track ${trackName}`);
    }
  }

  return tracks;
}