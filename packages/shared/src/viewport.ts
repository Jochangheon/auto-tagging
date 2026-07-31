/** Viewport mode for responsive platform detection */
export type ViewportMode = "pc" | "mo";

/** Platform tag (한진트래블 GA4 문서 플랫폼 칼럼) */
export type Platform = "PC" | "MO" | "All";

export const VIEWPORT_SIZES: Record<ViewportMode, { width: number; height: number }> = {
  pc: { width: 1280, height: 800 },
  mo: { width: 390, height: 844 },
};

/**
 * Firecrawl Xvfb / Selkies live-view stream canvas (always 1920×1080).
 * Chrome window bounds must match this so the stream is filled, not a tiny window on black.
 */
export const CDP_STREAM_BOUNDS = { width: 1920, height: 1080 } as const;

/** Emulated page viewport (innerWidth/innerHeight) per mode. */
export const CDP_DEVICE_METRICS: Record<ViewportMode, { width: number; height: number }> = {
  pc: { width: 1920, height: 1080 },
  mo: { width: 390, height: 844 },
};

/** @deprecated Use CDP_DEVICE_METRICS — kept for imports that expect the old name. */
export const CDP_LIVE_VIEWPORT = CDP_DEVICE_METRICS;

export interface PanelSizeHint {
  width?: number;
  height?: number;
}

/** Page viewport for tagging / responsive collect (MO = 390px). */
export function resolveCdpDeviceMetrics(
  mode: ViewportMode,
  _panel?: PanelSizeHint
): { width: number; height: number } {
  return CDP_DEVICE_METRICS[mode];
}

/** Chrome window size for live-view stream capture. */
export function resolveCdpStreamBounds(_mode: ViewportMode): { width: number; height: number } {
  return CDP_STREAM_BOUNDS;
}

/** @deprecated Use resolveCdpDeviceMetrics */
export function resolveCdpLiveViewport(
  mode: ViewportMode,
  panel?: PanelSizeHint
): { width: number; height: number } {
  return resolveCdpDeviceMetrics(mode, panel);
}

/** MO phone frame region inside the 1920×1080 stream (centered). */
export function resolveMoStreamCrop(): { x: number; y: number; width: number; height: number } {
  const device = CDP_DEVICE_METRICS.mo;
  const stream = CDP_STREAM_BOUNDS;
  return {
    x: Math.round((stream.width - device.width) / 2),
    y: Math.round((stream.height - device.height) / 2),
    width: device.width,
    height: device.height,
  };
}

export type HiddenReason =
  | "display_none"
  | "visibility_hidden"
  | "opacity_zero"
  | "zero_size"
  | "offscreen"
  | "collapsed_parent"
  | "visible";

export function parseViewportMode(raw: unknown): ViewportMode | null {
  if (raw === "pc" || raw === "PC") return "pc";
  if (raw === "mo" || raw === "MO") return "mo";
  return null;
}
