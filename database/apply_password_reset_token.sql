-- PasswordResetToken хүснэгт нэмэх (хаана ч User, Business гэх мэт хүснэгтүүд аль хэдийн байгаа бол)
-- Ажиллуулах: psql -U user -d bookez -f database/apply_password_reset_token.sql

CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_token_key" ON "PasswordResetToken"("token");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_token_idx" ON "PasswordResetToken"("token");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

ALTER TABLE "PasswordResetToken" DROP CONSTRAINT IF EXISTS "PasswordResetToken_userId_fkey";
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
