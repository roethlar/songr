/** The connected server owns this version, including in a remote desktop session. */
export interface UpdateCheckMetadata {
  currentVersion: string;
}

export type UpdateCheckStatus =
  | "update-available"
  | "current"
  | "ahead"
  | "no-release"
  | "unavailable";

export interface UpdateCheckResult extends UpdateCheckMetadata {
  status: UpdateCheckStatus;
  latestVersion: string | null;
  releaseUrl: string | null;
  checkedAt: string;
  message?: string;
  retryAt?: string;
}
