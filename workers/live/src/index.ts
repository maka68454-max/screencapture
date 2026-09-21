import {
  PublisherConnectInput,
  RealtimeTrack,
  RoomResult,
  SessionDescription,
} from './contracts';
import { LiveStreamRoom } from './room';

export { LiveStreamRoom } from './room';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_DURATION = 1800;
const MAX_VIEWERS = 25;
const STREAM_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return empty(204);

    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    try {
      if (request.method === 'POST' && url.pathname === '/v1/streams') {
        return await createStream(request, env);
      }

      if (segments.length < 3 || segments[0] !== 'v1' || segments[1] !== 'streams') {
        return json(404, { error: 'Not found' });
      }

      const streamId = segments[2];
      if (!STREAM_ID_PATTERN.test(streamId)) return json(400, { error: 'Invalid stream ID' });
      const room = env.LIVE_STREAM_ROOMS.getByName(streamId);
      const token = bearerToken(request);

      if (request.method === 'DELETE' && segments.length === 3) {
        return roomResponse(await room.delete(token));
      }

      if (segments[3] === 'publisher') {
        if (request.method === 'POST' && segments[4] === 'connect' && segments.length === 5) {
          const input = parsePublisherConnect(await readJson(request));
          return roomResponse(await room.connectPublisher(token, input));
        }
        if (request.method === 'POST' && segments[4] === 'heartbeat' && segments.length === 5) {
          return roomResponse(await room.heartbeatPublisher(token));
        }
        if (request.method === 'DELETE' && segments.length === 4) {
          return roomResponse(await room.stopPublisher(token));
        }
      }

      if (segments[3] === 'viewers') {
        if (request.method === 'POST' && segments.length === 4) {
          return roomResponse(await room.createViewerToken(token), 201);
        }
        if (request.method === 'POST' && segments[4] === 'connect' && segments.length === 5) {
          return roomResponse(await room.connectViewer(token));
        }

        const viewerId = segments[4];
        if (!viewerId || viewerId.length > 64) return json(400, { error: 'Invalid viewer ID' });

        if (request.method === 'PUT' && segments[5] === 'answer' && segments.length === 6) {
          const body = await readJson(request);
          return roomResponse(await room.answerViewer(viewerId, token, parseSessionDescription(body, 'answer')));
        }
        if (request.method === 'POST' && segments[5] === 'heartbeat' && segments.length === 6) {
          return roomResponse(await room.heartbeatViewer(viewerId, token));
        }
        if (request.method === 'PUT' && segments[5] === 'quality' && segments.length === 6) {
          const body = await readJson(request);
          if (!body || typeof body !== 'object') throw new ApiError(400, 'Invalid quality request');
          const quality = (body as Record<string, unknown>).quality;
          if (quality !== 'auto' && quality !== 'high' && quality !== 'medium' && quality !== 'low') {
            throw new ApiError(400, 'Invalid quality preference');
          }
          return roomResponse(await room.setViewerQuality(viewerId, token, quality));
        }
        if (request.method === 'POST' && segments[5] === 'reconnect' && segments.length === 6) {
          return roomResponse(await room.reconnectViewer(viewerId, token));
        }
        if (request.method === 'DELETE' && segments.length === 5) {
          return roomResponse(await room.disconnectViewer(viewerId, token));
        }
      }

      return json(404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof ApiError) return json(error.status, { error: error.message });

      console.error(JSON.stringify({
        message: 'live signaling request failed',
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return json(500, { error: 'Internal server error' });
    }
  },
} satisfies ExportedHandler<Env>;

async function createStream(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get('CF-Connecting-IP') ?? `unknown:${request.cf?.colo ?? 'local'}`;
  const rateLimit = await env.CREATE_RATE_LIMITER.limit({ key });
  if (!rateLimit.success) return json(429, { error: 'Stream creation rate limit exceeded' });

  const body = await readJson(request);
  if (!body || typeof body !== 'object') throw new ApiError(400, 'Invalid stream request');
  const input = body as Record<string, unknown>;
  const streamId = input.streamId;
  const duration = positiveInteger(input.duration, MAX_DURATION, 'duration');
  const maxViewers = positiveInteger(input.maxViewers, MAX_VIEWERS, 'maxViewers');
  if (typeof streamId !== 'string' || !STREAM_ID_PATTERN.test(streamId)) {
    throw new ApiError(400, 'Invalid stream ID');
  }

  const ownerToken = createToken();
  const publisherToken = createToken();
  const room = env.LIVE_STREAM_ROOMS.getByName(streamId);
  const result = await room.create({ streamId, duration, maxViewers, ownerToken, publisherToken });
  if (!result.ok) return roomResponse(result);

  return json(201, {
    streamId,
    ownerToken,
    publisherToken,
    expiresAt: result.value.expiresAt,
  });
}

function parsePublisherConnect(value: unknown): PublisherConnectInput {
  if (!value || typeof value !== 'object') throw new ApiError(400, 'Invalid publisher request');
  const input = value as Record<string, unknown>;
  const sessionDescription = parseSessionDescription(input.sessionDescription, 'offer');
  const rawTracks = input.tracks;
  if (!Array.isArray(rawTracks) || rawTracks.length < 1 || rawTracks.length > 2) {
    throw new ApiError(400, 'Invalid publisher tracks');
  }

  const tracks: RealtimeTrack[] = rawTracks.map((rawTrack) => {
    if (!rawTrack || typeof rawTrack !== 'object') throw new ApiError(400, 'Invalid publisher track');
    const track = rawTrack as Record<string, unknown>;
    if (
      track.location !== 'local'
      || typeof track.mid !== 'string'
      || track.mid.length > 32
      || (track.trackName !== 'video' && track.trackName !== 'audio')
    ) {
      throw new ApiError(400, 'Invalid publisher track');
    }
    return { location: 'local', mid: track.mid, trackName: track.trackName };
  });

  return {
    sessionDescription,
    tracks,
    audioAvailable: input.audioAvailable === true,
  };
}

function parseSessionDescription(value: unknown, type: SessionDescription['type']): SessionDescription {
  if (!value || typeof value !== 'object') throw new ApiError(400, `Invalid ${type}`);
  const description = value as Record<string, unknown>;
  if (description.type !== type || typeof description.sdp !== 'string' || !description.sdp || description.sdp.length > MAX_BODY_BYTES) {
    throw new ApiError(400, `Invalid ${type}`);
  }
  return { type, sdp: description.sdp };
}

async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) throw new ApiError(413, 'Payload too large');

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) throw new ApiError(413, 'Payload too large');

  try {
    return JSON.parse(body);
  } catch {
    throw new ApiError(400, 'Invalid JSON');
  }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) throw new ApiError(401, 'Bearer capability required');
  const token = authorization.slice(7);
  if (!token || token.length > 256) throw new ApiError(401, 'Invalid bearer capability');
  return token;
}

function positiveInteger(value: unknown, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ApiError(400, `${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function createToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function roomResponse<T>(result: RoomResult<T>, successStatus = 200): Response {
  return result.ok ? json(successStatus, result.value) : json(result.status, { error: result.error });
}

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': 'no-store',
    },
  });
}

function empty(status: number): Response {
  return new Response(null, { status, headers: CORS_HEADERS });
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}