-- CreateEnum
CREATE TYPE "CategoryKind" AS ENUM ('physical', 'digital', 'account');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('string', 'number', 'date', 'boolean', 'select', 'textarea');

-- CreateEnum
CREATE TYPE "AssetCondition" AS ENUM ('NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'DISPOSED');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'RETURNED', 'DISPOSED', 'IN_REPAIR');

-- CreateEnum
CREATE TYPE "PhotoType" AS ENUM ('FRONT', 'BACK', 'CONDITION', 'GENERAL');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'TEAM_LEADER');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'LEFT', 'ON_LEAVE');

-- CreateEnum
CREATE TYPE "DepartmentType" AS ENUM ('HOSPITAL', 'CALLCENTER');

-- CreateEnum
CREATE TYPE "AssignmentType" AS ENUM ('PHONE', 'LAPTOP', 'PRINTER', 'SIM', 'GENERAL');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETURNED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AssignmentItemRole" AS ENUM ('PRIMARY', 'SIM1', 'SIM2', 'CHARGER_CABLE', 'CHARGER_ADAPTER', 'BUNDLED');

-- CreateEnum
CREATE TYPE "TimelineEventType" AS ENUM ('ASSIGNED', 'RETURNED', 'REASSIGNED', 'UPDATED', 'DISCREPANCY', 'NOTE');

-- CreateEnum
CREATE TYPE "WhatsAppVariant" AS ENUM ('BUSINESS', 'NORMAL');

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('GMAIL', 'WHATSAPP', 'BITRIX', 'OTHER');

-- CreateEnum
CREATE TYPE "DiscrepancySeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "AssetCategory" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" UUID,
    "kind" "CategoryKind" NOT NULL DEFAULT 'physical',
    "codePrefix" TEXT NOT NULL DEFAULT 'AST',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetCategoryField" (
    "id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "FieldType" NOT NULL DEFAULT 'string',
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "isSearchable" BOOLEAN NOT NULL DEFAULT false,
    "isIdentifier" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AssetCategoryField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "categoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "serialNumber" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "condition" "AssetCondition" NOT NULL DEFAULT 'GOOD',
    "status" "AssetStatus" NOT NULL DEFAULT 'AVAILABLE',
    "roomId" UUID,
    "currentHolderEmployeeId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetCustomFieldValue" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "value" JSONB,

    CONSTRAINT "AssetCustomFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneDetail" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "imei" TEXT NOT NULL,
    "color" TEXT,
    "storage" TEXT,
    "model" TEXT,
    "make" TEXT,
    "carrier" TEXT,
    "operatingSystem" TEXT,
    "appBinary" "WhatsAppVariant",

    CONSTRAINT "PhoneDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" UUID NOT NULL,
    "assetId" UUID,
    "assignmentId" UUID,
    "accountId" UUID,
    "type" "PhotoType" NOT NULL DEFAULT 'GENERAL',
    "fileName" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "roomId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ip" TEXT,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "meta" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" UUID NOT NULL,
    "fullName" TEXT NOT NULL,
    "departmentTeamId" UUID NOT NULL,
    "roomId" UUID,
    "phoneContact" TEXT,
    "internalEmail" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentTeam" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DepartmentType" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "parentId" UUID,

    CONSTRAINT "DepartmentTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "teamType" "DepartmentType" NOT NULL DEFAULT 'CALLCENTER',
    "managerEmployeeId" UUID,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkIdentity" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "roomId" UUID,
    "departmentTeamId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,

    CONSTRAINT "WorkIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" UUID NOT NULL,
    "assignmentCode" TEXT NOT NULL,
    "type" "AssignmentType" NOT NULL,
    "employeeId" UUID NOT NULL,
    "workIdentityId" UUID,
    "assetId" UUID NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'DRAFT',
    "assignedAt" TIMESTAMP(3),
    "expectedReturnAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentItem" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "role" "AssignmentItemRole" NOT NULL DEFAULT 'BUNDLED',
    "conditionAtHandover" "AssetCondition" NOT NULL,
    "returnCondition" "AssetCondition",
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AssignmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentTimelineEntry" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "workIdentityId" UUID,
    "eventType" "TimelineEventType" NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentTimelineEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneAssignmentDetail" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "sim1Number" TEXT,
    "sim1AssetId" UUID,
    "wa1Business" BOOLEAN NOT NULL DEFAULT false,
    "wa1PhoneNumber" TEXT,
    "wa1BackupEmail" TEXT,
    "wa1BackupDate" TIMESTAMP(3),
    "wa1BackupUsedGB" DECIMAL(8,2),
    "wa1BackupTotalGB" DECIMAL(8,2),
    "wa1ChatNormalCount" INTEGER,
    "wa1ChatArchivedCount" INTEGER,
    "wa1AppVariant" "WhatsAppVariant",
    "sim2Number" TEXT,
    "sim2AssetId" UUID,
    "wa2Business" BOOLEAN NOT NULL DEFAULT false,
    "wa2PhoneNumber" TEXT,
    "wa2BackupEmail" TEXT,
    "wa2BackupDate" TIMESTAMP(3),
    "wa2BackupUsedGB" DECIMAL(8,2),
    "wa2BackupTotalGB" DECIMAL(8,2),
    "wa2ChatNormalCount" INTEGER,
    "wa2ChatArchivedCount" INTEGER,
    "wa2AppVariant" "WhatsAppVariant",
    "bitrixAccountId" UUID,
    "chargerCableAssetId" UUID,
    "chargerAdapterAssetId" UUID,
    "notes" TEXT,

    CONSTRAINT "PhoneAssignmentDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" UUID NOT NULL,
    "assetId" UUID,
    "kind" "AccountKind" NOT NULL,
    "subcategory" TEXT,
    "identifier" TEXT NOT NULL,
    "email" TEXT,
    "passwordEnc" TEXT NOT NULL,
    "isWhatsAppBackup" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "currentAssignmentId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnRecord" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "returnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedById" UUID NOT NULL,
    "returnCondition" "AssetCondition",
    "returnNotes" TEXT,

    CONSTRAINT "ReturnRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnComparisonField" (
    "id" UUID NOT NULL,
    "returnRecordId" UUID NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "valueAtHandover" JSONB,
    "valueAtReturn" JSONB,
    "isDiscrepancy" BOOLEAN NOT NULL DEFAULT false,
    "severity" "DiscrepancySeverity" NOT NULL DEFAULT 'INFO',

    CONSTRAINT "ReturnComparisonField_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssetCategory_parentId_idx" ON "AssetCategory"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetCategory_parentId_name_key" ON "AssetCategory"("parentId", "name");

-- CreateIndex
CREATE INDEX "AssetCategoryField_categoryId_idx" ON "AssetCategoryField"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetCategoryField_categoryId_key_key" ON "AssetCategoryField"("categoryId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_code_key" ON "Asset"("code");

-- CreateIndex
CREATE INDEX "Asset_categoryId_idx" ON "Asset"("categoryId");

-- CreateIndex
CREATE INDEX "Asset_roomId_idx" ON "Asset"("roomId");

-- CreateIndex
CREATE INDEX "Asset_currentHolderEmployeeId_idx" ON "Asset"("currentHolderEmployeeId");

-- CreateIndex
CREATE INDEX "Asset_status_idx" ON "Asset"("status");

-- CreateIndex
CREATE INDEX "Asset_serialNumber_idx" ON "Asset"("serialNumber");

-- CreateIndex
CREATE INDEX "AssetCustomFieldValue_fieldId_idx" ON "AssetCustomFieldValue"("fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetCustomFieldValue_assetId_fieldId_key" ON "AssetCustomFieldValue"("assetId", "fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneDetail_assetId_key" ON "PhoneDetail"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneDetail_imei_key" ON "PhoneDetail"("imei");

-- CreateIndex
CREATE INDEX "Photo_assetId_idx" ON "Photo"("assetId");

-- CreateIndex
CREATE INDEX "Photo_assignmentId_idx" ON "Photo"("assignmentId");

-- CreateIndex
CREATE INDEX "Photo_accountId_idx" ON "Photo"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_roomId_idx" ON "User"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Employee_roomId_idx" ON "Employee"("roomId");

-- CreateIndex
CREATE INDEX "Employee_departmentTeamId_idx" ON "Employee"("departmentTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_fullName_departmentTeamId_key" ON "Employee"("fullName", "departmentTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentTeam_name_key" ON "DepartmentTeam"("name");

-- CreateIndex
CREATE INDEX "DepartmentTeam_parentId_idx" ON "DepartmentTeam"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Room_code_key" ON "Room"("code");

-- CreateIndex
CREATE INDEX "WorkIdentity_roomId_idx" ON "WorkIdentity"("roomId");

-- CreateIndex
CREATE INDEX "WorkIdentity_departmentTeamId_idx" ON "WorkIdentity"("departmentTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkIdentity_name_roomId_key" ON "WorkIdentity"("name", "roomId");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_assignmentCode_key" ON "Assignment"("assignmentCode");

-- CreateIndex
CREATE INDEX "Assignment_employeeId_idx" ON "Assignment"("employeeId");

-- CreateIndex
CREATE INDEX "Assignment_assetId_idx" ON "Assignment"("assetId");

-- CreateIndex
CREATE INDEX "Assignment_workIdentityId_idx" ON "Assignment"("workIdentityId");

-- CreateIndex
CREATE INDEX "Assignment_status_idx" ON "Assignment"("status");

-- CreateIndex
CREATE INDEX "AssignmentItem_assetId_idx" ON "AssignmentItem"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentItem_assignmentId_assetId_key" ON "AssignmentItem"("assignmentId", "assetId");

-- CreateIndex
CREATE INDEX "AssignmentTimelineEntry_assetId_createdAt_idx" ON "AssignmentTimelineEntry"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "AssignmentTimelineEntry_assignmentId_createdAt_idx" ON "AssignmentTimelineEntry"("assignmentId", "createdAt");

-- CreateIndex
CREATE INDEX "AssignmentTimelineEntry_employeeId_createdAt_idx" ON "AssignmentTimelineEntry"("employeeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneAssignmentDetail_assignmentId_key" ON "PhoneAssignmentDetail"("assignmentId");

-- CreateIndex
CREATE INDEX "PhoneAssignmentDetail_sim1AssetId_idx" ON "PhoneAssignmentDetail"("sim1AssetId");

-- CreateIndex
CREATE INDEX "PhoneAssignmentDetail_sim2AssetId_idx" ON "PhoneAssignmentDetail"("sim2AssetId");

-- CreateIndex
CREATE INDEX "PhoneAssignmentDetail_bitrixAccountId_idx" ON "PhoneAssignmentDetail"("bitrixAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_assetId_key" ON "Account"("assetId");

-- CreateIndex
CREATE INDEX "Account_currentAssignmentId_idx" ON "Account"("currentAssignmentId");

-- CreateIndex
CREATE INDEX "Account_identifier_idx" ON "Account"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "Account_kind_identifier_key" ON "Account"("kind", "identifier");

-- CreateIndex
CREATE INDEX "ReturnRecord_assignmentId_idx" ON "ReturnRecord"("assignmentId");

-- CreateIndex
CREATE INDEX "ReturnComparisonField_returnRecordId_idx" ON "ReturnComparisonField"("returnRecordId");

-- AddForeignKey
ALTER TABLE "AssetCategory" ADD CONSTRAINT "AssetCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AssetCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetCategoryField" ADD CONSTRAINT "AssetCategoryField_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "AssetCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "AssetCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_currentHolderEmployeeId_fkey" FOREIGN KEY ("currentHolderEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetCustomFieldValue" ADD CONSTRAINT "AssetCustomFieldValue_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetCustomFieldValue" ADD CONSTRAINT "AssetCustomFieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "AssetCategoryField"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneDetail" ADD CONSTRAINT "PhoneDetail_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentTeamId_fkey" FOREIGN KEY ("departmentTeamId") REFERENCES "DepartmentTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentTeam" ADD CONSTRAINT "DepartmentTeam_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DepartmentTeam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_managerEmployeeId_fkey" FOREIGN KEY ("managerEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkIdentity" ADD CONSTRAINT "WorkIdentity_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkIdentity" ADD CONSTRAINT "WorkIdentity_departmentTeamId_fkey" FOREIGN KEY ("departmentTeamId") REFERENCES "DepartmentTeam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_workIdentityId_fkey" FOREIGN KEY ("workIdentityId") REFERENCES "WorkIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentItem" ADD CONSTRAINT "AssignmentItem_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentItem" ADD CONSTRAINT "AssignmentItem_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentTimelineEntry" ADD CONSTRAINT "AssignmentTimelineEntry_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentTimelineEntry" ADD CONSTRAINT "AssignmentTimelineEntry_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentTimelineEntry" ADD CONSTRAINT "AssignmentTimelineEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentTimelineEntry" ADD CONSTRAINT "AssignmentTimelineEntry_workIdentityId_fkey" FOREIGN KEY ("workIdentityId") REFERENCES "WorkIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentTimelineEntry" ADD CONSTRAINT "AssignmentTimelineEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneAssignmentDetail" ADD CONSTRAINT "PhoneAssignmentDetail_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneAssignmentDetail" ADD CONSTRAINT "PhoneAssignmentDetail_sim1AssetId_fkey" FOREIGN KEY ("sim1AssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneAssignmentDetail" ADD CONSTRAINT "PhoneAssignmentDetail_sim2AssetId_fkey" FOREIGN KEY ("sim2AssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneAssignmentDetail" ADD CONSTRAINT "PhoneAssignmentDetail_bitrixAccountId_fkey" FOREIGN KEY ("bitrixAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneAssignmentDetail" ADD CONSTRAINT "PhoneAssignmentDetail_chargerCableAssetId_fkey" FOREIGN KEY ("chargerCableAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneAssignmentDetail" ADD CONSTRAINT "PhoneAssignmentDetail_chargerAdapterAssetId_fkey" FOREIGN KEY ("chargerAdapterAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_currentAssignmentId_fkey" FOREIGN KEY ("currentAssignmentId") REFERENCES "Assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRecord" ADD CONSTRAINT "ReturnRecord_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRecord" ADD CONSTRAINT "ReturnRecord_returnedById_fkey" FOREIGN KEY ("returnedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnComparisonField" ADD CONSTRAINT "ReturnComparisonField_returnRecordId_fkey" FOREIGN KEY ("returnRecordId") REFERENCES "ReturnRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- README §5/§8: an asset can be in at most ONE active assignment at a time.
-- Prisma cannot express partial unique indexes, so it is added here.
CREATE UNIQUE INDEX "AssignmentItem_assetId_active_key" ON "AssignmentItem" ("assetId") WHERE "isActive" = true;

-- Sanity checks
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_qty_positive" CHECK ("qty" >= 0);
