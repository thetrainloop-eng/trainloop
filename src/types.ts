export interface IngestionRun {
  id: string;
  createdAt: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  documentsProcessed: number;
  changesDetected: number;
  error?: string;
}

export interface Document {
  id: string;
  googleDriveId: string;
  fileName: string;
  mimeType: string;
  lastModified: string;
  currentVersionId: string;
  currentHash: string;
  isDeleted?: boolean;
  deletedAt?: string;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  hash: string;
  content: string;
  createdAt: string;
}

export type ChangeSeverity = 'low' | 'medium' | 'high';

export interface ChangeReason {
  contentChanged?: boolean;
  nameChanged?: boolean;
  metadataChanged?: boolean;
  oldName?: string;
  newName?: string;
  lastSeenAt?: string;
  lastKnownName?: string;
  baselineDocCount?: number;
}

export interface ChangeRecord {
  id: string;
  documentId?: string;
  previousVersionId?: string;
  newVersionId?: string;
  changeType: 'created' | 'modified' | 'deleted' | 'renamed' | 'baseline';
  detectedAt: string;
  summary?: string;
  reason?: string;
  severity?: ChangeSeverity;
}
