export function isValidPlayerSource(source: unknown): source is number {
  return typeof source === 'number' && Number.isSafeInteger(source) && source > 0;
}

export function validatePlayerSource(source: unknown, operation: string): number | undefined {
  const normalizedSource = typeof source === 'string' && source.trim() ? Number(source) : source;
  if (isValidPlayerSource(normalizedSource)) return normalizedSource;

  const reason = source === undefined || source === null || source === 0 ? 'missing' : 'invalid';
  console.error(`[screencapture] Cannot ${operation}: player source is ${reason} (${String(source)})`);
  return;
}

export function emitNetToPlayer(eventName: string, source: unknown, ...args: unknown[]): boolean {
  if (typeof eventName !== 'string' || !eventName) {
    console.error('[screencapture] Cannot emit client event: event name is missing or invalid');
    return false;
  }

  const playerSource = validatePlayerSource(source, `emit "${eventName}"`);
  if (!playerSource) return false;

  try {
    emitNet(eventName, playerSource, ...args);
    return true;
  } catch (error) {
    console.error(`[screencapture] Failed to emit "${eventName}" to source ${playerSource}:`, error);
    return false;
  }
}