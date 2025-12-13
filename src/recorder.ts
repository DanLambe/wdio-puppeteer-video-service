import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Page } from 'puppeteer-core';
import type { CDPSession } from 'puppeteer-core';

const require = createRequire(import.meta.url);
let ffmpegPath: string | undefined;
try {
  ffmpegPath = require('ffmpeg-static');
} catch {
  // ffmpeg-static not available, will fallback to system ffmpeg
}

interface RecorderOptions {
  fps: number;
  width: number;
  height: number;
}

export class FfmpegRecorder {
  private _page: Page;
  private _ffmpeg?: ChildProcess;
  private _client?: CDPSession;
  private _options: RecorderOptions;

  constructor(page: Page, options: RecorderOptions) {
    this._page = page;
    this._options = options;
  }

  async start(outputFile: string): Promise<void> {
    // Start ffmpeg process
    // Flags based on performance requirements:
    // -f image2pipe: Input format is piped images
    // -vcodec mjpeg: Input codec is MJPEG (what Chrome sends)
    // -i -: Input from stdin
    // -y: Overwrite output
    // -vcodec libx264: Output codec
    // -preset ultrafast: prioritized for speed/low CPU
    // -crf 32: quality level (higher is lower quality/file size)
    // -pix_fmt yuv420p: Ensure compatibility
    // -r: Frame rate
    const args = [
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-i', '-',
      '-y',
      '-vcodec', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '32',
      '-pix_fmt', 'yuv420p',
      '-r', this._options.fps.toString(),
      outputFile
    ];

    const bin = ffmpegPath as string || 'ffmpeg'; // Fallback to system ffmpeg if static is null (rare)
    this._ffmpeg = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });

    if (this._ffmpeg) {
      this._ffmpeg.on('error', (e) => {
        console.error(`[FfmpegRecorder] Failed to spawn ffmpeg: ${e.message}`);
        this._ffmpeg = undefined;
      });

      this._ffmpeg.on('close', (code) => {
        if (code !== 0 && code !== 255) { // 255 is normal termination signal in some contexts
           // console.debug(`[FfmpegRecorder] ffmpeg exited with code ${code}`);
        }
      });
    }

    try {
      this._client = await this._page.createCDPSession();
      
      await this._client.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 80,
        maxWidth: this._options.width,
        maxHeight: this._options.height,
        everyNthFrame: 1 // We want every frame, or optimize? 1 is fine if we rely on ffmpeg to drop/manage or chrome to send at natural rate.
      });

      this._client.on('Page.screencastFrame', (event) => {
        // @ts-ignore - event type defs might differ slightly
        const { data, sessionId } = event;
        if (this._ffmpeg?.stdin?.writable) {
          this._ffmpeg.stdin.write(Buffer.from(data, 'base64'));
        }
        
        // Ack frame to get the next one
        this._client?.send('Page.screencastFrameAck', { sessionId })
          .catch(() => { /* ignore, session might be closed */ });
      });

    } catch (e) {
      console.error('[FfmpegRecorder] Error starting screencast:', e);
      this.stop(); // Clean up if start fails
    }
  }

  async stop(): Promise<void> {
    if (this._client) {
      try {
        await this._client.send('Page.stopScreencast');
        await this._client.detach();
      } catch (e) {
        // ignore errors during stop (session closed etc)
      }
      this._client = undefined;
    }


    if (this._ffmpeg) {
        if (this._ffmpeg.stdin && !this._ffmpeg.stdin.destroyed) {
            this._ffmpeg.stdin.end();
        }
        
        // Wait for process to exit gracefully
        await new Promise<void>((resolve) => {
            if (!this._ffmpeg || this._ffmpeg.exitCode !== null) return resolve();
            
            // Timeout safety
            const timeout = setTimeout(() => {
                 this._ffmpeg?.kill();
                 resolve();
            }, 5000);

            this._ffmpeg.on('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
        
        this._ffmpeg = undefined;
    }
  }
}
