
export interface WdioPuppeteerVideoServiceOptions {
  /**
   * Directory where videos will be saved.
   * @default 'videos'
   */
  outputDir?: string;
  
  /**
   * Whether to save all videos or only for failed tests.
   * @default false
   */
  saveAllVideos?: boolean;

  /**
   * Video frame width.
   * @default 1280
   */
  videoWidth?: number;

  /**
   * Video frame height.
   * @default 720
   */
  videoHeight?: number;

  /**
   * Video frame rate.
   * @default 30
   */
  fps?: number;
}
