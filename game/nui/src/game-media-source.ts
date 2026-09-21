import { createGameView } from '@screencapture/gameview';

export type GameMediaSourceOptions = {
  maxWidth?: number;
  maxHeight?: number;
  frameRate?: number;
};

export class GameMediaSource {
  #gameView: ReturnType<typeof createGameView> | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #mediaStream: MediaStream | null = null;
  #options: GameMediaSourceOptions | null = null;
  #generation = 0;

  get active(): boolean {
    return this.#mediaStream !== null;
  }

  async start(options: GameMediaSourceOptions = {}): Promise<MediaStream> {
    if (this.active) {
      throw new Error('Game media source is already active');
    }

    const generation = ++this.#generation;
    const { width, height } = this.calculateDimensions(options);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const gameView = createGameView(canvas);
    gameView.resize(width, height);

    this.#canvas = canvas;
    this.#gameView = gameView;
    this.#options = options;

    try {
      await this.waitForFrames(3);
      if (generation !== this.#generation) throw new Error('Game media source startup was cancelled');
      this.#mediaStream = canvas.captureStream(options.frameRate ?? 30);
      return this.#mediaStream;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  resize(): void {
    if (!this.#gameView || !this.#canvas || !this.#options) return;

    const { width, height } = this.calculateDimensions(this.#options);
    this.#canvas.width = width;
    this.#canvas.height = height;
    this.#gameView.resize(width, height);
  }

  stop(): void {
    this.#generation++;

    if (this.#mediaStream) {
      for (const track of this.#mediaStream.getTracks()) {
        track.stop();
      }
    }

    this.#gameView?.dispose();
    this.#canvas?.remove();

    this.#mediaStream = null;
    this.#gameView = null;
    this.#canvas = null;
    this.#options = null;
  }

  private calculateDimensions(options: GameMediaSourceOptions): { width: number; height: number } {
    const maxWidth = options.maxWidth ?? 1920;
    const maxHeight = options.maxHeight ?? 1080;
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;

    if (originalWidth <= maxWidth && originalHeight <= maxHeight) {
      return { width: originalWidth, height: originalHeight };
    }

    const scale = Math.min(maxWidth / originalWidth, maxHeight / originalHeight);
    return {
      width: Math.floor(originalWidth * scale),
      height: Math.floor(originalHeight * scale),
    };
  }

  private waitForFrames(count: number): Promise<void> {
    return new Promise((resolve) => {
      let waited = 0;
      const tick = () => {
        if (++waited >= count) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
}