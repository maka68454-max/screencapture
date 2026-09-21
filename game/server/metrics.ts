import { METRICS_ENABLED, METRICS_ENDPOINT, METRICS_WRITE_KEY } from '../telemetry-config';

declare function PerformHttpRequest(
  url: string,
  callback: (statusCode: number, body: string, headers: Record<string, string>, errorData?: string) => void,
  method?: string,
  data?: string,
  headers?: Record<string, string>,
): void;

type UploadMetricEvent = {
  event: 'upload_started' | 'upload_finished' | 'upload_failed';
  kind: 'image' | 'video';
  status: 'started' | 'success' | 'failed';
  uploadUrl: string;
  httpStatus?: number;
  bytes?: number;
  durationMs?: number;
  dataType?: string;
  captureId?: string;
  source?: number;
};

type UploadHttpError = Error & {
  httpStatus?: number;
};

function getResourceName(): string {
  try {
    return GetCurrentResourceName();
  } catch {
    return 'screencapture';
  }
}

function getResourceVersion(): string {
  try {
    return GetResourceMetadata(getResourceName(), 'version', 0) || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getUploadTarget(uploadUrl: string): { host?: string; path?: string } {
  try {
    const parsed = new URL(uploadUrl);
    return {
      host: parsed.hostname,
    };
  } catch {
    return {};
  }
}

function getHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const status = (err as UploadHttpError).httpStatus;
  return typeof status === 'number' ? status : undefined;
}

function getEndpointHost(): string {
  try {
    return new URL(METRICS_ENDPOINT).hostname;
  } catch {
    return 'metrics endpoint';
  }
}

function logMetricsFailure(reason: string): void {
  console.warn(`[screencapture] metrics upload failed for ${getEndpointHost()}: ${reason}`);
}

export function captureUploadMetric(metric: UploadMetricEvent): void {
  if (!METRICS_ENABLED || !METRICS_ENDPOINT) return;

  const target = getUploadTarget(metric.uploadUrl);
  const version = getResourceVersion();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (METRICS_WRITE_KEY) {
    headers['x-screencapture-key'] = METRICS_WRITE_KEY;
  }

  const body = JSON.stringify({
    event: metric.event,
    kind: metric.kind,
    status: metric.status,
    runtime: 'server',
    uploadHost: target.host,
    httpStatus: metric.httpStatus,
    bytes: metric.bytes,
    durationMs: metric.durationMs,
    dataType: metric.dataType,
    version,
    release: `screencapture@${version}`,
    captureId: metric.captureId,
    source: metric.source,
  });

  if (typeof PerformHttpRequest === 'function') {
    try {
      PerformHttpRequest(
        METRICS_ENDPOINT,
        (statusCode, _responseBody, _responseHeaders, errorData) => {
          if (statusCode >= 200 && statusCode < 300) return;
          logMetricsFailure(errorData || `HTTP ${statusCode}`);
        },
        'POST',
        body,
        headers,
      );
    } catch (err) {
      logMetricsFailure(err instanceof Error ? err.message : String(err));
    }

    return;
  }

  globalThis.fetch?.(METRICS_ENDPOINT, {
    method: 'POST',
    headers,
    body,
  }).catch((err) => {
    logMetricsFailure(err instanceof Error ? err.message : String(err));
  });
}

export function getUploadMetricHttpStatus(err: unknown): number | undefined {
  return getHttpStatus(err);
}