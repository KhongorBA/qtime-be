import { prisma } from '../config/db.js';

const DEFAULTS = {
  deposit_percent: '20',
  platform_fee_percent: '5',
  refund_percent: '100',
  trial_days: '90',
  currency: 'usd',
};

/**
 * Returns all platform config values merged with defaults.
 * Values come from the PlatformConfig table (admin-editable).
 */
export async function getPlatformConfig() {
  try {
    const rows = await prisma.platformConfig.findMany();
    const cfg = { ...DEFAULTS };
    for (const row of rows) {
      cfg[row.key] = row.value;
    }
    return cfg;
  } catch {
    return { ...DEFAULTS };
  }
}

export async function getPlatformConfigValue(key) {
  const cfg = await getPlatformConfig();
  return cfg[key] ?? DEFAULTS[key] ?? null;
}
