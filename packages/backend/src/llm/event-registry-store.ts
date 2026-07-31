import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EVENT_REGISTRY,
  findRegistryEventName,
  formatEventRegistryForPrompt,
  type EventRegistry,
} from "@autotag/shared";
import type { SnapshotSuggestion } from "@autotag/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, "../../data/event-registry.json");

export function getEventRegistryPath(): string {
  return REGISTRY_PATH;
}

/** Load persisted registry merged with defaults. */
export function loadEventRegistry(): EventRegistry {
  if (!existsSync(REGISTRY_PATH)) {
    return { ...DEFAULT_EVENT_REGISTRY };
  }
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as EventRegistry;
    return { ...DEFAULT_EVENT_REGISTRY, ...raw };
  } catch {
    return { ...DEFAULT_EVENT_REGISTRY };
  }
}

export function saveEventRegistry(registry: EventRegistry): void {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

export function formatLoadedRegistryForPrompt(registry?: EventRegistry): string {
  return formatEventRegistryForPrompt(registry ?? loadEventRegistry());
}

export interface RegistryApplyResult {
  registry: EventRegistry;
  created: string[];
  reused: string[];
}

/**
 * Apply LLM suggestions to registry — log reused/created, persist new names.
 */
export function applySuggestionsToEventRegistry(
  startRegistry: EventRegistry,
  suggestions: SnapshotSuggestion[]
): RegistryApplyResult {
  const next: EventRegistry = { ...startRegistry };
  const created: string[] = [];
  const reused: string[] = [];
  const logged = new Set<string>();

  for (const s of suggestions) {
    const name = s.event_name?.trim();
    if (!name || logged.has(name)) continue;

    const existingKey = findRegistryEventName(name, startRegistry);
    if (existingKey && !s.registry_created) {
      console.log(`[event-registry] reused="${existingKey}"`);
      reused.push(existingKey);
      logged.add(name);
      logged.add(existingKey);
      continue;
    }

    if (s.registry_created || !existingKey) {
      const key = existingKey ?? name;
      if (!next[key]) {
        const reason = s.new_event_reason ?? s.rationale ?? "LLM 정의 이벤트";
        next[key] = reason;
        created.push(key);
        console.log(`[event-registry] created="${key}" reason="${reason}"`);
      }
      logged.add(name);
      logged.add(key);
    }
  }

  if (created.length > 0) {
    saveEventRegistry(next);
  }

  return { registry: next, created, reused };
}
