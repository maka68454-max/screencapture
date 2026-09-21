export type Context = {
  source: number;
};

export function getEventContext(): Context {
  const _source = global.source;
  return {
    source: _source,
  };
}
