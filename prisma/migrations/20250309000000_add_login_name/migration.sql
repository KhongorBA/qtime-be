-- AlterTable
ALTER TABLE "User" ADD COLUMN "loginName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_loginName_key" ON "User"("loginName");
