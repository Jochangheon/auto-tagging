import type { ViewportMode } from "@autotag/shared";
import { createKanuAdapter } from "./kanu-adapter.js";
import type { SiteAdapter } from "../types.js";

export { KANU_GNB_MENUS } from "./kanu-adapter.js";

export function pickSiteAdapter(url: string, viewport: ViewportMode): SiteAdapter | undefined {
  const adapters: SiteAdapter[] = [createKanuAdapter(viewport)];
  return adapters.find((a) => a.matches(url, viewport));
}
