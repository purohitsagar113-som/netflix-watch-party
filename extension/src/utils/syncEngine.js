/**
 * CineSync Drift Correction Engine
 * Manages playback synchronization, drift thresholds, and network latency compensation.
 */
export class DriftCorrectionEngine {
  constructor(options = {}) {
    this.HARD_SEEK_THRESHOLD = options.hardSeekThreshold || 1.8; // Seconds
    this.SOFT_RATE_THRESHOLD = options.softRateThreshold || 0.4; // Seconds
    this.onHardSeek = options.onHardSeek || (() => {});
    this.onRateChange = options.onRateChange || (() => {});
    this.lastSeekTime = 0;
  }

  /**
   * Evaluates drift between local video and remote host packet
   * @param {number} localTime - Current local playback time in seconds
   * @param {number} remoteTime - Host playback time from server packet in seconds
   * @param {boolean} remoteIsPlaying - Whether the host is currently playing
   * @param {number} packetTimestamp - Timestamp when host emitted the packet
   */
  evaluate(localTime, remoteTime, remoteIsPlaying, packetTimestamp = Date.now()) {
    // 1. Compensate for network transit latency (estimated half-RTT or clock difference)
    const transitLatencySec = Math.max(0, (Date.now() - packetTimestamp) / 1000);
    const targetTime = remoteIsPlaying ? remoteTime + transitLatencySec : remoteTime;

    const drift = Math.abs(localTime - targetTime);

    // Prevent seek thrashing: don't hard seek more often than once every 1.5 seconds
    const now = Date.now();
    const canSeek = now - this.lastSeekTime > 1500;

    if (drift > this.HARD_SEEK_THRESHOLD && canSeek) {
      console.log(`[DriftEngine] Critical drift detected: ${drift.toFixed(2)}s. Triggering hard seek.`);
      this.lastSeekTime = now;
      this.onHardSeek(targetTime);
      this.onRateChange(1.0);
      return { status: "HARD_SEEK", drift, targetTime };
    }

    if (drift > this.SOFT_RATE_THRESHOLD && remoteIsPlaying) {
      // Soft drift adjustment: slightly accelerate or decelerate to converge without abrupt jumps
      if (localTime < targetTime) {
        // Falling behind, speed up slightly
        this.onRateChange(1.06);
        return { status: "ACCELERATING", drift, rate: 1.06 };
      } else {
        // Ahead, slow down slightly
        this.onRateChange(0.94);
        return { status: "DECELERATING", drift, rate: 0.94 };
      }
    }

    // Within acceptable sync delta (< 0.4s)
    this.onRateChange(1.0);
    return { status: "SYNCED", drift, rate: 1.0 };
  }
}
