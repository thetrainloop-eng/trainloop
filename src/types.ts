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
export type ExplanationStatus = 'pending' | 'generated' | 'failed' | 'skipped';

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

export interface ChangeItem {
  change_type: 'added' | 'removed' | 'modified';
  location: string | null;
  before_excerpt: string | null;
  after_excerpt: string | null;
  plain_english_change: string;
  why_it_matters: string;
  recommended_action: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface SOPRequirement {
  requirement: string;
  applies_to: string | null;
  what_is_new: string;
  before_excerpt: string | null;
  after_excerpt: string;
  operational_impact: string;
  category: 'step' | 'obligation' | 'system' | 'training' | 'storage' | 'responsibility';
  confidence: 'low' | 'medium' | 'high';
}

export interface ExplanationBullets {
  what_changed: string[];
  why_it_matters: string[];
  recommended_actions: string[];
  change_items?: ChangeItem[];
  new_or_changed_requirements?: SOPRequirement[];
}

export interface ExplanationMeta {
  model?: string;
  promptVersion?: string;
  inputsUsed?: string[];
  confidence?: 'low' | 'medium' | 'high';
  deterministic?: boolean;
  highRiskDetected?: boolean;
  highRiskPhrases?: string[];
  skippedAI?: boolean;
  documentType?: 'policy' | 'procedural' | 'general';
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
  explanationText?: string;
  explanationBullets?: string;
  explanationMeta?: string;
  explanationStatus?: ExplanationStatus;
  explanationError?: string;
  explainedAt?: string;
}

export interface ExplanationInput {
  changeRecord: ChangeRecord;
  documentName?: string;
  previousContent?: string;
  newContent?: string;
  reason?: ChangeReason;
}

export interface ExplanationOutput {
  text: string;
  bullets: ExplanationBullets;
  meta: ExplanationMeta;
}
