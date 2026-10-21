-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'CALL_CENTER_MANAGER';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "scope" TEXT;
