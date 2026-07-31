export function logExpandFailed(
  selector: string,
  method: string,
  reason: string
): void {
  console.warn(`[menu-explorer] expand_failed selector=${selector} method=${method} reason=${reason}`);
}

export function logExpandSucceeded(
  key: string,
  depth: number,
  method: string,
  durationMs: number
): void {
  console.log(
    `[menu-explorer] expand_succeeded key=${key} depth=${depth} method=${method} durationMs=${durationMs}`
  );
}

export function logMaxDepthReached(depth: number, key: string): void {
  console.log(`[menu-explorer] max_depth_reached depth=${depth} at=${key}`);
}

export function logMaxStatesReached(count: number, cap: number): void {
  console.warn(`[menu-explorer] max_states_reached count=${count} cap=${cap}`);
}

export function logRevealPathFailed(stepIndex: number, key: string, reason: string): void {
  console.warn(
    `[menu-explorer] reveal_path_failed step=${stepIndex} key=${key} reason=${reason}`
  );
}

export function logSharedPanelTagged(
  triggerLabel: string,
  tagged: number,
  links: string[]
): void {
  console.log(
    `[menu-explorer] shared_panel_tagged trigger="${triggerLabel}" new_tags=${tagged} links=[${links.slice(0, 8).join(", ")}]`
  );
}
