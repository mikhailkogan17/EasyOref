/**
 * Alert state store — Redis operations.
 *
 * Keys:
 *   alert:{alertId}:meta   — {messageId, chatId, isCaption, alertTs, alertType}  TTL 20min
 *   alert:{alertId}:posts  — LPUSH list of ChannelPost JSON                       TTL 20min
 *   alert:active           — {alertId, alertTs, alertType}                        TTL 20min
 */

import { getRedis } from "./redis.js";
import type { AlertType } from "./types.js";

const TTL_S = 20 * 60; // 20 minutes

// ── Types ──────────────────────────────────────────────

export interface AlertMeta {
  alertId: string;
  messageId: number;
  chatId: string;
  isCaption: boolean; // true = sent as animation (edit via editMessageCaption)
  alertTs: number; // Date.now() when alert was sent
  alertType: AlertType;
  alertAreas: string[]; // Hebrew area names from the alert
  currentText: string; // original message text for editing
}

export interface ChannelPost {
  channel: string;
  text: string;
  ts: number;
  /** https://t.me/username/messageId — for the sources footer */
  messageUrl?: string;
}

export interface ActiveAlert {
  alertId: string;
  alertTs: number;
  alertType: AlertType;
}

// ── Store ──────────────────────────────────────────────

export async function saveAlertMeta(meta: AlertMeta): Promise<void> {
  const redis = getRedis();
  const key = `alert:${meta.alertId}:meta`;
  await redis.setex(key, TTL_S, JSON.stringify(meta));
  await setActiveAlert({
    alertId: meta.alertId,
    alertTs: meta.alertTs,
    alertType: meta.alertType,
  });
}

export async function getAlertMeta(alertId: string): Promise<AlertMeta | null> {
  const redis = getRedis();
  const raw = await redis.get(`alert:${alertId}:meta`);
  return raw ? (JSON.parse(raw) as AlertMeta) : null;
}

export async function pushChannelPost(
  alertId: string,
  post: ChannelPost,
): Promise<void> {
  const redis = getRedis();
  const key = `alert:${alertId}:posts`;
  await redis.lpush(key, JSON.stringify(post));
  await redis.expire(key, TTL_S);
}

export async function getChannelPosts(alertId: string): Promise<ChannelPost[]> {
  const redis = getRedis();
  const key = `alert:${alertId}:posts`;
  const items = await redis.lrange(key, 0, -1);
  return items.map((i: string) => JSON.parse(i) as ChannelPost);
}

export async function setActiveAlert(active: ActiveAlert): Promise<void> {
  const redis = getRedis();
  await redis.setex("alert:active", TTL_S, JSON.stringify(active));
}

export async function getActiveAlert(): Promise<ActiveAlert | null> {
  const redis = getRedis();
  const raw = await redis.get("alert:active");
  return raw ? (JSON.parse(raw) as ActiveAlert) : null;
}

export async function clearActiveAlert(): Promise<void> {
  const redis = getRedis();
  await redis.del("alert:active");
}
