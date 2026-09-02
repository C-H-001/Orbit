export function getTimelineReference(sourceEmailId?: string) {
  return {
    label: "查看原邮件" as const,
    emailId: sourceEmailId,
    disabled: !sourceEmailId,
  };
}
