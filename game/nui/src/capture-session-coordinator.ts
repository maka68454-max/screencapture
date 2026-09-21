export type CaptureSessionKind = 'recording' | 'live';

class CaptureSessionCoordinator {
  #activeSession: { kind: CaptureSessionKind; id: string } | null = null;

  acquire(kind: CaptureSessionKind, id: string): boolean {
    if (this.#activeSession) return false;

    this.#activeSession = { kind, id };
    return true;
  }

  release(kind: CaptureSessionKind, id: string): void {
    if (this.#activeSession?.kind === kind && this.#activeSession.id === id) {
      this.#activeSession = null;
    }
  }
}

export const captureSessionCoordinator = new CaptureSessionCoordinator();