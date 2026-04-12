-- Migration: add_payments_subscription
-- Adds: stripeCustomerId on User, extended Payment fields,
--       PlatformConfig table, BusinessSubscription table

-- 1. User: add stripeCustomerId
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;

-- 2. Payment: add deposit/remainder/fee fields
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "depositAmount"         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "remainderAmount"        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "platformFee"            DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "depositIntentId"        TEXT,
  ADD COLUMN IF NOT EXISTS "remainderIntentId"      TEXT,
  ADD COLUMN IF NOT EXISTS "stripePaymentMethodId"  TEXT,
  ADD COLUMN IF NOT EXISTS "depositCapturedAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "remainderCapturedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refundedAt"             TIMESTAMP(3);

-- 3. PlatformConfig table
CREATE TABLE IF NOT EXISTS "PlatformConfig" (
  "key"       TEXT NOT NULL,
  "value"     TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("key")
);

-- Seed default config values
INSERT INTO "PlatformConfig" ("key", "value", "updatedAt") VALUES
  ('deposit_percent',       '20',  NOW()),
  ('platform_fee_percent',  '5',   NOW()),
  ('refund_percent',        '100', NOW()),
  ('trial_days',            '90',  NOW()),
  ('currency',              'usd', NOW())
ON CONFLICT ("key") DO NOTHING;

-- 4. SubscriptionStatus enum
DO $$ BEGIN
  CREATE TYPE "SubscriptionStatus" AS ENUM ('trial', 'active', 'grace', 'expired');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 5. BusinessSubscription table
CREATE TABLE IF NOT EXISTS "BusinessSubscription" (
  "id"                   TEXT NOT NULL,
  "businessId"           TEXT NOT NULL,
  "trialStartedAt"       TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "trialEndsAt"          TIMESTAMP(3) NOT NULL,
  "status"               "SubscriptionStatus" NOT NULL DEFAULT 'trial',
  "stripeSubscriptionId" TEXT,
  "stripeCustomerId"     TEXT,
  "currentPeriodEnd"     TIMESTAMP(3),
  "warningSent7d"        BOOLEAN NOT NULL DEFAULT false,
  "warningSent3d"        BOOLEAN NOT NULL DEFAULT false,
  "warningSent1d"        BOOLEAN NOT NULL DEFAULT false,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "BusinessSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessSubscription_businessId_key"
  ON "BusinessSubscription"("businessId");

CREATE INDEX IF NOT EXISTS "BusinessSubscription_status_idx"
  ON "BusinessSubscription"("status");

CREATE INDEX IF NOT EXISTS "BusinessSubscription_trialEndsAt_idx"
  ON "BusinessSubscription"("trialEndsAt");

ALTER TABLE "BusinessSubscription"
  DROP CONSTRAINT IF EXISTS "BusinessSubscription_businessId_fkey";

ALTER TABLE "BusinessSubscription"
  ADD CONSTRAINT "BusinessSubscription_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
