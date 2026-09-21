export type DataType = 'base64' | 'blob';

type Encoding = 'webp' | 'jpg' | 'png';

export interface UploadData {
  callback: CallbackFn | ScreenshotBasicCallbackFn;
  isRemote: boolean;
  remoteConfig: CaptureOptions | null;
  dataType: DataType;
  url?: string;
  playerSource?: number;
  correlationId?: string;
  screenshotBasicCompatibility?: boolean;
}

export function createScreenshotBasicUploadData(
  params: Omit<UploadData, 'callback' | 'screenshotBasicCompatibility'> & { callback: ScreenshotBasicCallbackFn },
): UploadData {
  return {
    ...params,
    callback: params.callback,
    screenshotBasicCompatibility: true,
  };
}

export function createRegularUploadData(
  params: Omit<UploadData, 'callback' | 'screenshotBasicCompatibility'> & { callback: CallbackFn },
): UploadData {
  return {
    ...params,
    callback: params.callback,
    screenshotBasicCompatibility: false,
  };
}

export interface StreamUploadData {
  captureId: string;
  token: string;
  source: number;
  tempFilePath: string;
  bytesReceived: number;
  callback: CallbackFn;
  isRemote: boolean;
  remoteUrl?: string;
  remoteConfig?: StreamRemoteConfig;
  startedAt: number;
  duration?: number;
  legacyCallback?: boolean;
}

export type VideoCaptureResult = {
  captureId: string;
  source: number;
  status: 'success' | 'error';
  filePath?: string;
  response?: unknown;
  bytesReceived: number;
  duration?: number;
  reason?: 'manual' | 'duration' | 'finalized';
  error?: string;
};

// Remote upload config specific to video streams.
export interface StreamRemoteConfig {
  headers?: HeadersInit;
  formField?: string; // defaults to 'file'
  filename?: string; // becomes <filename>.webm — defaults to 'recording'
}

// Parameters accepted by UploadStore.addStream() — tempFilePath is derived
// from the generated token so it is not provided by the caller.
export type AddStreamParams = {
  captureId: string;
  source: number;
  tempDir: string;
  callback: CallbackFn;
  isRemote?: boolean;
  remoteUrl?: string;
  remoteConfig?: StreamRemoteConfig;
  duration?: number;
  legacyCallback?: boolean;
};

export interface RemoteConfig {
  url: string;
  headers?: HeadersInit;
  formField?: string;
  filename?: string;
  encoding?: string;
}

export interface CaptureOptions {
  headers?: HeadersInit;
  formField?: string;
  filename?: string;
  // screenshot-basic compatibility alias for filename
  fileName?: string;
  encoding?: string;
  maxWidth?: number;
  maxHeight?: number;
  duration?: number;
}

export type CallbackFn = (data: unknown, _playerSource?: number, correlationId?: string) => void;
export type ScreenshotBasicCallbackFn = (err: string | boolean, data: string) => void;

export interface CallbackData {
  imageData: string | Buffer<ArrayBuffer>;
  dataType: string;
}

export interface RequestBody {
  imageData: string;
  dataType: DataType;
}

export type RequestUploadToken = {
  url: string;
  encoding: Encoding;
  quality: number;
  headers: Headers;
  correlationId: string;
  filename: string;
};

export type LiveStreamState = 'provisioning' | 'connecting' | 'live' | 'reconnecting' | 'failed' | 'stopped';

export type LiveStreamOptions = {
  maxWidth?: number;
  maxHeight?: number;
  frameRate?: number;
  duration?: number;
  maxViewers?: number;
};

export type LiveStreamStatus = {
  streamId: string;
  state: Exclude<LiveStreamState, 'provisioning'>;
  audioAvailable: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
  error?: string;
};

export type LiveStreamReadyResult = {
  streamId: string;
  source: number;
  status: 'ready';
  expiresAt: number;
  audioAvailable: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
};

export type LiveStreamErrorResult = {
  streamId: string;
  source: number;
  status: 'error';
  error: string;
};

export type LiveStreamResult = LiveStreamReadyResult | LiveStreamErrorResult;
export type LiveStreamCallback = (result: LiveStreamResult) => void;

export type LiveStreamEntry = {
  streamId: string;
  source: number;
  state: LiveStreamState;
  callback: LiveStreamCallback;
  callbackResolved: boolean;
  audioAvailable: boolean;
  createdAt: number;
  ownerToken?: string;
  publisherToken?: string;
  expiresAt?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  error?: string;
  expiryTimeout?: ReturnType<typeof setTimeout>;
};

export type ProvisionedLiveStream = {
  streamId: string;
  ownerToken: string;
  publisherToken: string;
  expiresAt: number;
};

export type LiveStreamViewerGrant = {
  streamId: string;
  viewerToken: string;
  expiresAt: number;
};
