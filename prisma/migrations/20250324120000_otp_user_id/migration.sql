-- AlterTable
ALTER TABLE "OtpVerification" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OtpVerification_userId_purpose_destination_idx" ON "OtpVerification"("userId", "purpose", "destination");

-- AddForeignKey
ALTER TABLE "OtpVerification" DROP CONSTRAINT IF EXISTS "OtpVerification_userId_fkey";
ALTER TABLE "OtpVerification" ADD CONSTRAINT "OtpVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
