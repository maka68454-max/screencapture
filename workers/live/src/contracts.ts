export type SessionDescription = {
  type: 'answer' | 'offer';
  sdp: string;
};

export type RealtimeTrack = {
  location: 'local' | 'remote';
  mid?: string;
  sessionId?: string;
  trackName: string;
  kind?: 'audio' | 'video';
  simulcast?: {
    preferredRid: string;
    priorityOrdering: 'none' | 'asciibetical';
    ridNotAvailable: 'none' | 'asciibetical';
  };
  errorCode?: string;
  errorDescription?: string;
};

export type TracksRequest = {
  sessionDescription?: SessionDescription;
  tracks: RealtimeTrack[];
};

export type TracksResponse = {
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: SessionDescription;
  tracks?: RealtimeTrack[];
  errorCode?: string;
  errorDescription?: string;
};

export type RoomResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

export type CreateStreamInput = {
  streamId: string;
  duration: number;
  maxViewers: number;
  ownerToken: string;
  publisherToken: string;
};

export type PublisherConnectInput = {
  sessionDescription: SessionDescription;
  tracks: RealtimeTrack[];
  audioAvailable: boolean;
};

export type PublisherConnectResult = {
  sessionDescription: SessionDescription;
};

export type ViewerConnectResult = {
  viewerId: string;
  viewerSessionToken: string;
  expiresAt: number;
  sessionDescription: SessionDescription;
};

export type ViewerTokenResult = {
  streamId: string;
  viewerToken: string;
  expiresAt: number;
};