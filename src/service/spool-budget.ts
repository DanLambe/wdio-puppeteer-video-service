import type { DiskSpaceBoundary } from './boundaries.js'

const MEBIBYTE = 1024 * 1024
const GIBIBYTE = 1024 * MEBIBYTE

/**
 * What one recording may spool, and how much free disk the spool volume needs.
 * The numbers are about disk, not about the recording's length.
 */
export interface SpoolLimits {
  /** Bytes the recording's spools may hold before it continues as live encoding. */
  readonly promoteBytes: number
  /** Bytes the recording's spools may never exceed; capture stops first. */
  readonly hardCapBytes: number
  /** Free space below which a spooling segment continues as live encoding. */
  readonly promoteFreeBytes: number
  /** Free space below which a segment that is still spooling stops capturing. */
  readonly stopFreeBytes: number
  /** Bytes a segment spools between two free-space checks. */
  readonly freeCheckIntervalBytes: number
}

export const DEFAULT_SPOOL_LIMITS: SpoolLimits = Object.freeze({
  promoteBytes: 256 * MEBIBYTE,
  hardCapBytes: GIBIBYTE,
  promoteFreeBytes: 2 * GIBIBYTE,
  stopFreeBytes: 512 * MEBIBYTE,
  freeCheckIntervalBytes: 16 * MEBIBYTE,
})

/** What a segment's recorder does when its budget decides. */
export interface SegmentBudgetHandlers {
  /** Continue the segment as live encoding; asked once per segment. */
  promote(): void
  /** Stop capturing: the free-space floor was crossed after a check. */
  stop(detail: string): void
  /** Whether the segment is only spooling: not promoting, not yet live. */
  isSpooling(): boolean
}

/**
 * The spool budget of one recording. It decides; sinks only report bytes. Its
 * total is every spool of the recording still on disk, sealed or active, plus
 * what the active one has accepted and not yet flushed. A sealed spool counts
 * as the bytes it held when sealed, so a check never reads it again.
 */
export class SpoolBudget {
  readonly limits: SpoolLimits
  private readonly diskSpace: DiskSpaceBoundary
  // Segments whose sinks may still accept bytes.
  private readonly active = new Set<SegmentBudget>()
  private sealedBytes = 0
  private promotedState = false

  constructor(limits: SpoolLimits, diskSpace: DiskSpaceBoundary) {
    this.limits = limits
    this.diskSpace = diskSpace
  }

  /** Bytes of every spool of the recording still on disk. */
  get bytes(): number {
    let total = this.sealedBytes
    for (const segment of this.active) {
      total += segment.bytes
    }
    return total
  }

  /** Whether later segments of this recording start live. */
  get promoted(): boolean {
    return this.promotedState
  }

  markPromoted(): void {
    this.promotedState = true
  }

  /**
   * Registers a spool segment. `bytes` reports what its sink has accepted
   * until the segment is sealed; it is not called after that.
   */
  beginSegment(directory: string, bytes: () => number): SegmentBudget {
    const segment = new SegmentBudget(this, directory, bytes)
    this.active.add(segment)
    return segment
  }

  /** `undefined` when the check fails: unknown free space never stops capture. */
  async readFreeBytes(directory: string): Promise<number | undefined> {
    try {
      const free = await this.diskSpace.freeBytes(directory)
      return Number.isFinite(free) ? free : undefined
    } catch {
      return undefined
    }
  }

  /** The segment's sink accepts no more bytes: it counts as `bytes` from now. */
  seal(segment: SegmentBudget, bytes: number): void {
    if (this.active.delete(segment)) {
      this.sealedBytes += bytes
    }
  }

  /** The spool left the disk or never existed. */
  forget(segment: SegmentBudget, sealedBytes: number | undefined): void {
    if (sealedBytes === undefined) {
      this.active.delete(segment)
    } else {
      this.sealedBytes -= sealedBytes
    }
  }
}

/** One spool segment's view of its recording's budget. */
export class SegmentBudget {
  private readonly recording: SpoolBudget
  private readonly directory: string
  private readonly reportBytes: () => number
  private handlers: SegmentBudgetHandlers | undefined
  private freeBytes: number | undefined
  private lastSampleBytes = 0
  private promotionRequested = false
  private state: 'active' | 'sealed' | 'released' = 'active'
  // The bytes the sink had accepted when it was sealed.
  private sealedBytes = 0
  private sampling = false

  constructor(
    recording: SpoolBudget,
    directory: string,
    reportBytes: () => number,
  ) {
    this.recording = recording
    this.directory = directory
    this.reportBytes = reportBytes
  }

  /** Bytes this segment's sink has accepted, or had when it was sealed. */
  get bytes(): number {
    return this.state === 'active' ? this.reportBytes() : this.sealedBytes
  }

  attach(handlers: SegmentBudgetHandlers): void {
    this.handlers = handlers
  }

  /** The check at segment start. It never delays the start. */
  begin(): void {
    this.sample()
  }

  /**
   * Called before the segment commits more bytes to its spool. `pendingBytes`
   * is what it has queued and what it must still be able to write, so the
   * recording's spools never pass the hard cap. Returns why the segment must
   * stop capturing now, or `undefined`.
   */
  check(pendingBytes: number): string | undefined {
    if (this.state !== 'active') {
      return undefined
    }
    const { limits } = this.recording
    const accepted = this.recording.bytes
    if (accepted + pendingBytes > limits.hardCapBytes) {
      this.recording.markPromoted()
      return `The recording's frame spools reached the disk limit of ${formatSize(limits.hardCapBytes)}`
    }
    if (accepted >= limits.promoteBytes) {
      this.requestPromotion()
    }
    if (this.bytes - this.lastSampleBytes >= limits.freeCheckIntervalBytes) {
      this.sample()
    }
    return this.lowSpaceReason()
  }

  /**
   * The recorder has finished writing to the spool: stopped, aborted, or its
   * file failed. Its final byte count is kept; the sink is not asked again
   * and the segment decides nothing more.
   */
  seal(): void {
    if (this.state !== 'active') {
      return
    }
    this.sealedBytes = this.reportBytes()
    this.state = 'sealed'
    this.handlers = undefined
    this.recording.seal(this, this.sealedBytes)
  }

  /** The spool left the disk, or its segment never started. */
  release(): void {
    if (this.state === 'released') {
      return
    }
    const sealed = this.state === 'sealed' ? this.sealedBytes : undefined
    this.state = 'released'
    this.handlers = undefined
    this.recording.forget(this, sealed)
  }

  private requestPromotion(): void {
    this.recording.markPromoted()
    if (this.promotionRequested || !this.handlers) {
      return
    }
    this.promotionRequested = true
    this.handlers.promote()
  }

  private lowSpaceReason(): string | undefined {
    const free = this.freeBytes
    const { stopFreeBytes } = this.recording.limits
    if (
      free === undefined ||
      free >= stopFreeBytes ||
      !this.handlers?.isSpooling()
    ) {
      return undefined
    }
    return `Free disk space for the frame spool fell to ${formatSize(free)}, below the floor of ${formatSize(stopFreeBytes)}`
  }

  private sample(): void {
    if (this.sampling || this.state !== 'active') {
      return
    }
    this.sampling = true
    this.lastSampleBytes = this.bytes
    void this.recording.readFreeBytes(this.directory).then((free) => {
      this.sampling = false
      // A sample that resolves after the seal or release changes nothing.
      if (this.state === 'active' && free !== undefined) {
        this.applyFreeSpace(free)
      }
    })
  }

  private applyFreeSpace(free: number): void {
    const { promoteFreeBytes } = this.recording.limits
    this.freeBytes = free
    if (free < promoteFreeBytes) {
      this.requestPromotion()
    }
    const reason = this.lowSpaceReason()
    if (reason) {
      this.handlers?.stop(reason)
    }
  }
}

const formatSize = (bytes: number): string => {
  if (bytes >= GIBIBYTE) {
    return `${(bytes / GIBIBYTE).toFixed(1)} GiB`
  }
  if (bytes >= MEBIBYTE) {
    return `${(bytes / MEBIBYTE).toFixed(1)} MiB`
  }
  return `${Math.round(bytes).toString()} bytes`
}
