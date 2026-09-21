import { uploadStore } from './bootstrap';
import { base64ToBuffer } from './process-upload';
import { appendFile } from 'node:fs/promises';
import { finalizeStream } from './koa-router';
import { getEventContext } from './context';
import { emitNetToPlayer } from './net';

type StreamAck = {
  ok: boolean;
  error?: string;
};

function sendAck(responseEvent: string | undefined, source: number, response: StreamAck): void {
  if (responseEvent) {
    emitNetToPlayer(responseEvent, source, response);
  }
}

export function registerStreamHandlers() {
  onNet('screencapture:stream-chunk-nui', async (responseEventOrToken: string, tokenOrBase64Data: string, maybeBase64Data?: string) => {
    const ctx = getEventContext();
    const hasAck = maybeBase64Data !== undefined;
    const responseEvent = hasAck ? responseEventOrToken : undefined;
    const token = hasAck ? tokenOrBase64Data : responseEventOrToken;
    const base64Data = hasAck ? maybeBase64Data : tokenOrBase64Data;

    try {
      const streamData = uploadStore.getStream(token);
      const chunk = base64ToBuffer(base64Data);

      await appendFile(streamData.tempFilePath, chunk);
      streamData.bytesReceived += chunk.length;
      sendAck(responseEvent, ctx.source, { ok: true });
    } catch (err) {
      console.error('[screencapture] stream-chunk-nui error:', err);
      sendAck(responseEvent, ctx.source, {
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  onNet('screencapture:stream-finalize-nui', async (responseEventOrToken: string, maybeToken?: string) => {
    const ctx = getEventContext();
    const hasAck = maybeToken !== undefined;
    const responseEvent = hasAck ? responseEventOrToken : undefined;
    const token = hasAck ? maybeToken : responseEventOrToken;

    try {
      const streamData = uploadStore.getStream(token);
      uploadStore.removeStream(token);

      await finalizeStream(streamData);
      sendAck(responseEvent, ctx.source, { ok: true });
    } catch (err) {
      console.error('[screencapture] stream-finalize-nui error:', err);
      sendAck(responseEvent, ctx.source, {
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });
}
