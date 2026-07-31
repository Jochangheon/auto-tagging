/** Site-specific overlay / popup dismissal — selectors live in adapters only. */
export interface OverlayDismissHints {
  /** Extra close-button selectors (merged with generic defaults). */
  closeButtonSelectors?: string[];
  /** Valid CSS only — removed via querySelectorAll in page context. */
  domRemoveSelectors?: string[];
  /** Playwright locator strings — removed via locator.evaluate (adapter only). */
  playwrightRemoveSelectors?: string[];
  /** Valid CSS only — hidden via injected stylesheet. */
  suppressOverlaySelectors?: string[];
  /** Optional point to verify nothing blocks GNB (elementFromPoint). */
  verifyProbePoint?: { x: number; y: number };
  /** Loop until blocking_gnb=false (default 8). */
  maxDismissAttempts?: number;
}
