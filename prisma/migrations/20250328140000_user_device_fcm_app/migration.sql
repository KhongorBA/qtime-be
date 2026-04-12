-- AlterTable
ALTER TABLE "UserDevice" ADD COLUMN IF NOT EXISTS "fcmApp" TEXT NOT NULL DEFAULT 'consumer';
