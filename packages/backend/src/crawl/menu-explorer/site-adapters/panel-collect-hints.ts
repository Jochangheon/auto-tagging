/** Hints for collectHeaderPanelAnchors — site-specific patterns live in adapters only. */
export interface PanelCollectHints {
  /** 1st priority: explicit panel container selectors (first match with anchors wins). */
  panelContainerSelectors?: string[];
  /** 1st priority: className regex patterns tested on elements under header/banner. */
  panelClassPatterns?: string[];
  /** When using class patterns, require position:absolute (default true). */
  requireAbsolute?: boolean;
  /** Optional menu-block selectors for parent mapping (site-specific assist only). */
  menuBlockSelectors?: string[];
  /** Generic heuristic: minimum menu blocks inside panel (default 2). */
  minMenuBlocks?: number;
  /** Generic heuristic: max px below header bottom (default 400). */
  headerProximityPx?: number;
}
