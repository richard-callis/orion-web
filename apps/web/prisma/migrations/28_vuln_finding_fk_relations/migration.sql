-- AddForeignKey: VulnerabilityFinding.taskId → Task.id (SetNull)
ALTER TABLE "VulnerabilityFinding" ADD CONSTRAINT "VulnerabilityFinding_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: VulnerabilityFinding.scanId → VulnerabilityScan.id (SetNull)
ALTER TABLE "VulnerabilityFinding" ADD CONSTRAINT "VulnerabilityFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "VulnerabilityScan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
