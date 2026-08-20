/*
  Warnings:

  - You are about to drop the column `admNo` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `className` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `feeBalance` on the `Student` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[adm]` on the table `Student` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `adm` to the `Student` table without a default value. This is not possible if the table is not empty.
  - Added the required column `cls` to the `Student` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Student_admNo_key";

-- AlterTable
ALTER TABLE "Student" DROP COLUMN "admNo",
DROP COLUMN "className",
DROP COLUMN "feeBalance",
ADD COLUMN     "adm" TEXT NOT NULL,
ADD COLUMN     "cls" TEXT NOT NULL,
ADD COLUMN     "daysOverdue" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "paid" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "txnRef" TEXT,
    "studentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Student_adm_key" ON "Student"("adm");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
