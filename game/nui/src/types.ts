export enum CaptureStreamActions {
    Start = "capture-stream-start",
    Stop = "capture-stream-stop"
}

export enum LiveStreamActions {
    Start = "live-stream-start",
    Stop = "live-stream-stop"
}

export type LiveStreamState = 'connecting' | 'live' | 'reconnecting' | 'failed' | 'stopped';

export type LiveStreamStartRequest = {
    action: LiveStreamActions.Start;
    endpoint: string;
    statusCallbackUrl: string;
    streamId: string;
    publisherToken: string;
    expiresAt: number;
    maxWidth?: number;
    maxHeight?: number;
    frameRate?: number;
};

export type LiveStreamStopRequest = {
    action: LiveStreamActions.Stop;
    streamId?: string;
};

export type LiveStreamStatus = {
    streamId: string;
    state: LiveStreamState;
    audioAvailable: boolean;
    width?: number;
    height?: number;
    frameRate?: number;
    error?: string;
};