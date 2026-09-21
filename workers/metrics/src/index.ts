export interface Env {
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_API_HOST?: string;
  TELEMETRY_WRITE_KEY?: string;
}

type IncomingTelemetryEvent = {
  event?: unknown;
  kind?: unknown;
  status?: unknown;
  runtime?: unknown;
  uploadHost?: unknown;
  httpStatus?: unknown;
  bytes?: unknown;
  durationMs?: unknown;
  dataType?: unknown;
  version?: unknown;
  release?: unknown;
  captureId?: unknown;
  source?: unknown;
};

type SanitizedTelemetryEvent = {
  _time: string;
  event: string;
  kind?: string;
  status?: string;
  runtime?: string;
  uploadHost?: string;
  httpStatus?: number;
  bytes?: number;
  durationMs?: number;
  dataType?: string;
  version?: string;
  release?: string;
  captureId?: string;
  source?: number;
  worker: {
    country?: string;
    colo?: string;
    userAgent?: string;
  };
};

const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVENTS_PER_REQUEST = 25;

const ALLOWED_EVENTS = new Set([
  'upload_started',
  'upload_finished',
  'upload_failed',
  'capture_started',
  'capture_finished',
  'capture_failed',
]);

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-screencapture-key',
};

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  return trimmed.slice(0, maxLength);
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeHost(value: unknown): string | undefined {
  const raw = text(value, 300);
  if (!raw) return undefined;

  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase().slice(0, 200);
  } catch {
    const host = raw.split('/')[0]?.split('?')[0]?.split(':')[0]?.toLowerCase();
    if (!host || !/^[a-z0-9.-]+$/.test(host)) return undefined;
    return host.slice(0, 200);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'application/json',
    },
  });
}

function empty(status: number): Response {
  return new Response(null, {
    status,
    headers: CORS_HEADERS,
  });
}

function sanitizeEvent(input: IncomingTelemetryEvent, request: Request): SanitizedTelemetryEvent | undefined {
  const event = text(input.event, 80);
  if (!event || !ALLOWED_EVENTS.has(event)) return undefined;

  return {
    _time: new Date().toISOString(),
    event,
    kind: text(input.kind, 40),
    status: text(input.status, 40),
    runtime: text(input.runtime, 40),
    uploadHost: sanitizeHost(input.uploadHost),
    httpStatus: number(input.httpStatus),
    bytes: number(input.bytes),
    durationMs: number(input.durationMs),
    dataType: text(input.dataType, 40),
    version: text(input.version, 80),
    release: text(input.release, 120),
    captureId: text(input.captureId, 120),
    source: number(input.source),
    worker: {
      country: text(request.cf?.country, 20),
      colo: text(request.cf?.colo, 20),
      userAgent: text(request.headers.get('user-agent'), 300),
    },
  };
}

async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    throw new Response(JSON.stringify({ error: 'Payload too large' }), {
      status: 413,
      headers: {
        ...CORS_HEADERS,
        'content-type': 'application/json',
      },
    });
  }

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    throw new Response(JSON.stringify({ error: 'Payload too large' }), {
      status: 413,
      headers: {
        ...CORS_HEADERS,
        'content-type': 'application/json',
      },
    });
  }

  return JSON.parse(body);
}

function getAxiomIngestUrl(env: Env): string | undefined {
  const dataset = text(env.AXIOM_DATASET, 120);
  if (!dataset) return undefined;

  const host = text(env.AXIOM_API_HOST, 300) ?? 'api.axiom.co';
  const baseUrl = host.startsWith('http://') || host.startsWith('https://') ? host : `https://${host}`;
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  return `${normalizedBaseUrl}/v1/datasets/${encodeURIComponent(dataset)}/ingest`;
}

async function forwardToAxiom(env: Env, events: SanitizedTelemetryEvent[]): Promise<Response> {
  const token = text(env.AXIOM_TOKEN, 500);
  const ingestUrl = getAxiomIngestUrl(env);

  if (!token || !ingestUrl) {
    return json(500, { error: 'Axiom is not configured' });
  }

  const response = await fetch(ingestUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(events),
  });

  if (!response.ok) {
    return json(502, { error: 'Axiom ingest failed' });
  }

  return empty(204);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return empty(204);
    if (request.method !== 'POST') return empty(405);

    if (env.TELEMETRY_WRITE_KEY) {
      const key = request.headers.get('x-screencapture-key');
      if (key !== env.TELEMETRY_WRITE_KEY) return empty(401);
    }

    let body: unknown;
    try {
      body = await readJson(request);
    } catch (err) {
      if (err instanceof Response) return err;
      return json(400, { error: 'Invalid JSON' });
    }

    const rawEvents = Array.isArray(body) ? body.slice(0, MAX_EVENTS_PER_REQUEST) : [body];
    const events = rawEvents
      .filter((event): event is IncomingTelemetryEvent => Boolean(event) && typeof event === 'object')
      .map((event) => sanitizeEvent(event, request))
      .filter((event): event is SanitizedTelemetryEvent => Boolean(event));

    if (!events.length) {
      return json(400, { error: 'No valid telemetry events' });
    }

    return forwardToAxiom(env, events);
  },
};