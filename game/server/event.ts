import { type Context, getEventContext } from './context';
import { emitNetToPlayer } from './net';

type Event<T = unknown, R = unknown> = {
  body: T;
  ctx: Context;
  send: (data: R) => void;
};

export function eventController<TData, TResponse = void>(
  event: string,
  callback: (req: Event<TData, TResponse>) => Promise<void>,
): void {
  onNet(event, async (responseEvent: string, data: TData) => {
    const ctx = getEventContext();

    function send(data: TResponse): void {
      emitNetToPlayer(responseEvent, ctx.source, data);
    }

    // TODO: Add status codes or something to the response
    await callback({
      body: data,
      ctx: ctx,
      send,
    });
  });
}
