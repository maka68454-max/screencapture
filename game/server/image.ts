import { eventController } from './event';
import { RequestUploadToken, createRegularUploadData } from './types';
import { uploadStore } from './bootstrap';
import { processUpload, uploadFile, base64ToBuffer } from './process-upload';
import { emitNetToPlayer } from './net';

export function registerImageHandlers() {
  eventController<RequestUploadToken, string>(
    'screencapture:INTERNAL_requestUploadToken',
    async ({ ctx, body, send }) => {
      function uploadCallback(
        response: unknown,
        playerSource: number | undefined,
        correlationId: string | undefined,
      ): void {
        emitNetToPlayer(
          'screencapture:INTERNAL_uploadComplete',
          playerSource,
          JSON.stringify(response),
          correlationId,
        );
      }

      const token = uploadStore.addUpload(createRegularUploadData({
        callback: uploadCallback,
        isRemote: true,
        remoteConfig: {
          filename: body ? body.filename : undefined,
          encoding: body.encoding,
          headers: body.headers,
          formField: 'file',
        },
        url: body.url,
        dataType: 'blob',
        playerSource: ctx.source,
        correlationId: body.correlationId,
      }));

      return send(token);
    },
  );

  onNet('screencapture:capture-screen', async (token: string, base64Data: string) => {
    try {
      const uploadData = uploadStore.getUpload(token);
      await processUpload(uploadData, base64Data);
    } catch (err) {
      console.error('[screencapture] capture-screen error:', err);
    }
  });

  onNet('screencapture:PerformUploadProxy', async (token: string, base64Data: string) => {
    const uploadData = uploadStore.getUpload(token);
    if (!uploadData) return;

    const { callback, url, remoteConfig, dataType, screenshotBasicCompatibility, playerSource, correlationId } = uploadData;

    try {
      const rawBuffer = base64ToBuffer(base64Data);

      const response = await uploadFile(url, remoteConfig, rawBuffer, 'blob', uploadData);

      if (screenshotBasicCompatibility) {
        (callback as any)(false, response);
      } else {
        if (playerSource && correlationId) {
          (callback as any)(response, playerSource, correlationId);
        } else {
          (callback as any)(response);
        }
      }
    } catch (err) {
      if (err instanceof Error) {
        if (screenshotBasicCompatibility) {
          (callback as any)(err.message, null);
        } else {
          if (playerSource && correlationId) {
            (callback as any)(JSON.stringify({ error: err.message }), playerSource, correlationId);
          } else {
            (callback as any)(JSON.stringify({ error: err.message }));
          }
        }
      } else {
        if (screenshotBasicCompatibility) {
          (callback as any)('An unknown error occurred', null);
        } else {
          if (playerSource && correlationId) {
            (callback as any)(JSON.stringify({ error: 'An unknown error occurred' }), playerSource, correlationId);
          } else {
            (callback as any)(JSON.stringify({ error: 'An unknown error occurred' }));
          }
        }
      }
    }
  });
}
