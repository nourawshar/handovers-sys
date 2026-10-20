-- CreateEnum
CREATE TYPE "PhotoContext" AS ENUM ('HANDOVER', 'RETURN');

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "context" "PhotoContext" NOT NULL DEFAULT 'HANDOVER';
