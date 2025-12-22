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
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  hash: string;
  content: string;
  createdAt: string;
}

export interface ChangeRecord {
  id: string;
  documentId: string;
  previousVersionId?: string;
  newVersionId: string;
  changeType: 'created' | 'modified' | 'deleted';
  detectedAt: string;
  summary?: string;
}
