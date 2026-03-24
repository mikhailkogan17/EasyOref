/**
 * EasyOref — Persistent GIF Rotation State
 *
 * Stores which GIFs have been shown to avoid repeats.
 * State survives restarts + redeploys via JSON file.
 */

import * as logger from "@easyoref/monitoring";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface GifBags {
  [poolKey: string]: string[];
}

interface GifStateFile {
  version: 1;
  bags: GifBags;
}

let gifBags: GifBags = {};
let stateFilePath = "";

/**
 * Initialize persistent GIF state.
 * @param dataDir — directory for state file (created if missing)
 */
export function initGifState(dataDir: string): void {
  stateFilePath = join(dataDir, "gif-state.json");

  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // dir may already exist
  }

  if (existsSync(stateFilePath)) {
    try {
      const raw = readFileSync(stateFilePath, "utf-8");
      const parsed: GifStateFile = JSON.parse(raw) as GifStateFile;
      if (parsed.version === 1 && parsed.bags) {
        gifBags = parsed.bags;
        logger.info("GIF state loaded", {
          pools: Object.keys(gifBags).length,
          path: stateFilePath,
        });
        return;
      }
    } catch {
      logger.warn("Corrupt gif-state.json — starting fresh");
    }
  }

  gifBags = {};
  persist();
}

function persist(): void {
  try {
    const state: GifStateFile = { version: 1, bags: gifBags };
    writeFileSync(stateFilePath, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    logger.warn("Failed to persist GIF state", { error: String(err) });
  }
}

/**
 * Pick a GIF from a pool without repeats.
 * When all GIFs in the pool have been shown, reshuffles.
 */
export function pickGif(pool: string[], poolKey: string): string {
  let bag = gifBags[poolKey];
  if (!bag || bag.length === 0) {
    bag = [...pool].sort(() => Math.random() - 0.5);
    gifBags[poolKey] = bag;
  }
  const gif = bag.pop()!;
  persist();
  return gif;
}
