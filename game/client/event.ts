import { uuidv4 } from './utils';

export function uniqueId() {
  return uuidv4();
}

export async function netEventController<TResponse>(event: string, ...args: any[]): Promise<TResponse> {
  return new Promise((resolve) => {
    const eventId = uniqueId();
    const listenName = `${event}:${eventId}`;

    emitNet(event, listenName, ...args);

    const eventListener = (data: TResponse) => {
      removeEventListener(listenName, eventListener);
      resolve(data);
    };

    onNet(listenName, eventListener);
  });
}
