import type { PanelSettings } from '@mcpanel/shared';
import { inArray } from 'drizzle-orm';
import type { DB } from '../db/client';
import { settings } from '../db/schema';

const KEYS = {
  panelName: 'panel_name',
  defaultTimezone: 'default_timezone',
  auditRetentionDays: 'audit_retention_days',
} as const;

export const DEFAULT_SETTINGS: PanelSettings = {
  panelName: 'MC Panel',
  defaultTimezone: 'Asia/Shanghai',
  auditRetentionDays: 90,
};

export class SettingsService {
  constructor(private readonly db: DB) {}

  get(): PanelSettings {
    const rows = this.db
      .select()
      .from(settings)
      .where(inArray(settings.key, Object.values(KEYS)))
      .all();
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const retention = Number(stored.get(KEYS.auditRetentionDays));
    return {
      panelName: stored.get(KEYS.panelName) ?? DEFAULT_SETTINGS.panelName,
      defaultTimezone: stored.get(KEYS.defaultTimezone) ?? DEFAULT_SETTINGS.defaultTimezone,
      auditRetentionDays:
        Number.isInteger(retention) && retention >= 1 && retention <= 3650
          ? retention
          : DEFAULT_SETTINGS.auditRetentionDays,
    };
  }

  update(patch: Partial<PanelSettings>): PanelSettings {
    const now = Date.now();
    for (const [field, key] of Object.entries(KEYS) as Array<[keyof PanelSettings, string]>) {
      const value = patch[field];
      if (value === undefined) continue;
      this.db
        .insert(settings)
        .values({ key, value: String(value), updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { value: String(value), updatedAt: now } })
        .run();
    }
    return this.get();
  }
}
