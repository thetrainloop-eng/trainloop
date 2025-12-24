import "dotenv/config"
import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { googleDriveService } from './services/googleDrive';
import { schedulerService } from './services/scheduler';
import { authManager } from './auth';
import { getExplanationGenerator, generateAndStoreExplanation, backfillNullExplanations } from './services/explanationGenerator';
import { ChangeRecord, ChangeReason, DocumentVersion, IngestionRun, ExplanationInput } from './types';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = parseInt(process.env.PORT || '5000', 10);

app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize database, auth, and scheduler
(async () => {
  try {
    await db.initialize();
    await authManager.loadAccessTokenFromDatabase();
    
    // Initialize scheduler with ingestion callback
    schedulerService.setIngestionCallback(async (runId: string, folderId: string) => {
      await runIngestionForScheduler(runId, folderId);
    });
    await schedulerService.initialize();
  } catch (error) {
    console.error('Failed to initialize:', error);
  }
})();

// Wrapper for scheduler to run ingestion
async function runIngestionForScheduler(runId: string, folderId: string): Promise<void> {
  const run: IngestionRun = {
    id: runId,
    createdAt: new Date().toISOString(),
    status: 'pending',
    documentsProcessed: 0,
    changesDetected: 0,
  };
  await db.createIngestionRun(run);
  await startIngestion(runId, folderId);
}

// Queue explanation generation (non-blocking)
function queueExplanation(
  changeRecord: ChangeRecord,
  documentName?: string,
  previousContent?: string,
  newContent?: string
): void {
  const generator = getExplanationGenerator();
  
  let parsedReason = {};
  if (changeRecord.reason) {
    try {
      parsedReason = JSON.parse(changeRecord.reason);
    } catch {
      parsedReason = {};
    }
  }
  
  const input: ExplanationInput = {
    changeRecord,
    documentName,
    previousContent,
    newContent,
    reason: parsedReason,
  };
  
  generateAndStoreExplanation(changeRecord.id, generator, input).catch((err) => {
    console.error(`Failed to generate explanation for ${changeRecord.id}:`, err);
  });
}

// List Drive Files
app.get("/drive/files", async (req, res) => {
  try {
    if (!(await authManager.isAuthenticated())) {
      return res.status(401).json({ error: "Not authenticated. Visit /auth/google first." });
    }

    // Use env folder if present, otherwise require query param
    const folderId = process.env.DRIVE_FOLDER_ID || (req.query.folderId as string | undefined);

    if (!folderId) {
      return res.status(400).json({ error: "Missing folderId. Set DRIVE_FOLDER_ID or pass ?folderId=..." });
    }

    const files = await googleDriveService.listFiles(folderId);
    res.json({ count: files.length, files });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Unknown error" });
  }
});

// Health check
app.get('/health', async (req: Request, res: Response) => {
  const connected = await authManager.isAuthenticated();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    googleDriveConnected: connected,
  });
});

// Google OAuth login endpoint
app.get('/auth/google', (req: Request, res: Response) => {
  const authUrl = authManager.getAuthUrl();
  console.log('Redirecting to Google OAuth with URL:', authUrl);
  res.redirect(authUrl);
});

// Google OAuth callback endpoint
app.get('/auth/callback', async (req: Request, res: Response) => {
  try {
    const { code, error: googleError } = req.query;

    if (googleError) {
      console.error('Google OAuth error:', googleError);
      return res.status(400).json({ 
        error: 'Google authentication failed',
        details: googleError 
      });
    }

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Authorization code is required' });
    }

    await authManager.exchangeCodeForToken(code);
    res.json({
      success: true,
      message: 'Successfully authenticated with Google Drive',
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('OAuth callback error:', errorMsg);
    res.status(500).json({ 
      error: 'Failed to authenticate with Google Drive',
      details: errorMsg 
    });
  }
});

// Serve index.html for root path
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// Serve privacy policy
app.get('/privacy-policy', (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'public', 'privacy-policy.html'));
});

// Get all ingestion runs
app.get('/api/ingestion-runs', async (req: Request, res: Response) => {
  try {
    const runs = await db.getIngestionRuns();
    res.json(runs);
  } catch (error) {
    console.error('Error fetching ingestion runs:', error);
    res.status(500).json({ error: 'Failed to fetch ingestion runs' });
  }
});

// Create manual ingestion run
app.post('/api/ingestion-runs', async (req: Request, res: Response) => {
  try {
    const { googleDriveFolderId } = req.body;

    if (!googleDriveFolderId) {
      return res.status(400).json({ error: 'googleDriveFolderId is required' });
    }

    const runId = uuidv4();
    const run: IngestionRun = {
      id: runId,
      createdAt: new Date().toISOString(),
      status: 'pending',
      documentsProcessed: 0,
      changesDetected: 0,
    };

    await db.createIngestionRun(run);

    // Start ingestion in background
    startIngestion(runId, googleDriveFolderId).catch(console.error);

    res.json(run);
  } catch (error) {
    console.error('Error creating ingestion run:', error);
    res.status(500).json({ error: 'Failed to create ingestion run' });
  }
});

// Get documents
app.get('/api/documents', async (req: Request, res: Response) => {
  try {
    const documents = await db.getAllDocuments();
    res.json(documents);
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// Get document details with versions and changes
app.get('/api/documents/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const document = await db.getDocument(id);

    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const versions = await db.getDocumentVersions(id);
    const changes = await db.getChangeRecords(id);

    res.json({
      document,
      versions,
      changes,
    });
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

// Get change records
app.get('/api/change-records', async (req: Request, res: Response) => {
  try {
    const changes = await db.getChangeRecords();
    res.json(changes);
  } catch (error) {
    console.error('Error fetching change records:', error);
    res.status(500).json({ error: 'Failed to fetch change records' });
  }
});

// Dashboard status endpoint - aggregates all status info
app.get('/api/dashboard', async (req: Request, res: Response) => {
  try {
    backfillNullExplanations().catch(err => console.error('Backfill error:', err));
    
    const connected = await authManager.isAuthenticated();
    const scheduler = schedulerService.getConfig();
    const lastRun = await db.getLatestIngestionRun();
    const recentChanges = await db.getRecentChanges(10);
    const documents = await db.getAllDocuments();
    
    res.json({
      googleDrive: {
        connected,
        folderId: scheduler.folderId || process.env.DRIVE_FOLDER_ID || null,
      },
      scheduler: {
        enabled: scheduler.enabled,
        intervalMinutes: scheduler.intervalMinutes,
        lastRun: scheduler.lastRun,
        nextRun: scheduler.nextRun,
      },
      lastIngestion: lastRun ? {
        id: lastRun.id,
        status: lastRun.status,
        createdAt: lastRun.createdAt,
        documentsProcessed: lastRun.documentsProcessed,
        changesDetected: lastRun.changesDetected,
      } : null,
      stats: {
        totalDocuments: documents.length,
        recentChanges: recentChanges.length,
      },
      recentChanges,
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// Scheduler API endpoints
app.get('/api/scheduler', (req: Request, res: Response) => {
  res.json(schedulerService.getConfig());
});

app.post('/api/scheduler', async (req: Request, res: Response) => {
  try {
    const { enabled, intervalMinutes, folderId } = req.body;
    const updates: any = {};
    
    if (typeof enabled === 'boolean') updates.enabled = enabled;
    if (typeof intervalMinutes === 'number' && intervalMinutes >= 1) updates.intervalMinutes = intervalMinutes;
    if (typeof folderId === 'string') updates.folderId = folderId;
    
    const config = await schedulerService.updateConfig(updates);
    res.json(config);
  } catch (error) {
    console.error('Error updating scheduler:', error);
    res.status(500).json({ error: 'Failed to update scheduler' });
  }
});

app.post('/api/scheduler/start', async (req: Request, res: Response) => {
  try {
    schedulerService.start();
    res.json(schedulerService.getConfig());
  } catch (error) {
    console.error('Error starting scheduler:', error);
    res.status(500).json({ error: 'Failed to start scheduler' });
  }
});

app.post('/api/scheduler/stop', (req: Request, res: Response) => {
  schedulerService.stop();
  res.json(schedulerService.getConfig());
});

app.post('/api/scheduler/run-now', async (req: Request, res: Response) => {
  try {
    const result = await schedulerService.runNow();
    if (result.runId) {
      res.json({ success: true, runId: result.runId });
    } else if (result.error === 'Ingestion already in progress') {
      res.status(409).json({ error: result.error, inProgress: true });
    } else {
      res.status(400).json({ error: result.error || 'Cannot run: No folder configured' });
    }
  } catch (error) {
    console.error('Error running scheduled ingestion:', error);
    res.status(500).json({ error: 'Failed to run ingestion' });
  }
});

// Check if ingestion is currently running
app.get('/api/scheduler/status', (req: Request, res: Response) => {
  res.json({
    ...schedulerService.getConfig(),
    ingestionInProgress: schedulerService.isIngestionRunning(),
  });
});

// Ingestion logic with baseline detection, deletion detection, reasons, and severity
async function startIngestion(runId: string, googleDriveFolderId: string): Promise<void> {
  try {
    console.log(`\n🚀 Starting ingestion run ${runId} for folder ${googleDriveFolderId}`);
    
    // Check if authenticated
    if (!(await authManager.isAuthenticated())) {
      console.error('❌ Not authenticated with Google Drive. Cannot start ingestion.');
      await db.updateIngestionRun(runId, {
        status: 'failed',
        error: 'Not authenticated with Google Drive',
      });
      return;
    }
    
    await db.updateIngestionRun(runId, { status: 'in_progress' });

    // Check if this is a baseline run (no documents exist at all, including deleted ones)
    // This ensures baseline only happens on the truly first ingestion ever
    const totalDocCount = await db.getTotalDocumentCount();
    const isBaselineRun = totalDocCount === 0;
    if (isBaselineRun) {
      console.log('📋 BASELINE RUN: First ingestion ever - will suppress individual CREATED records');
    }

    // Fetch files from Google Drive folder
    console.log('📥 Fetching files from Google Drive...');
    const files = await googleDriveService.listFiles(googleDriveFolderId);
    console.log(`📦 Received ${files.length} files from Google Drive`);

    // Build set of current Google Drive IDs for deletion detection
    const currentDriveIds = new Set<string>();

    let changesDetected = 0;
    let docsProcessed = 0;

    for (const file of files) {
      // Filter for supported document types
      const supportedMimes = [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.google-apps.document',
      ];

      if (!supportedMimes.includes(file.mimeType)) {
        continue;
      }

      currentDriveIds.add(file.id);
      docsProcessed++;

      // Download and extract content
      const content = await extractContent(file);

      if (!content) {
        continue;
      }

      // For Google Docs, always use sha256 of exported content (no md5Checksum available)
      const hash = (file.mimeType === 'application/vnd.google-apps.document' || !file.md5Checksum)
        ? `sha256:${googleDriveService.computeHash(content)}`
        : `md5:${file.md5Checksum}`;

      // Log file details for debugging
      console.log(`  📊 Processing: ${file.name} | mime: ${file.mimeType} | content length: ${content.length} | hash: ${hash.substring(0, 20)}...`);

      // Check if document exists (including soft-deleted ones that reappeared)
      let document = await db.getDocumentByGoogleDriveId(file.id);

      if (!document) {
        // New document
        const docId = googleDriveService.generateId();
        const versionId = googleDriveService.generateId();

        document = {
          id: docId,
          googleDriveId: file.id,
          fileName: file.name,
          mimeType: file.mimeType,
          lastModified: file.modifiedTime,
          currentVersionId: versionId,
          currentHash: hash,
        };

        await db.createDocument(document);

        const version: DocumentVersion = {
          id: versionId,
          documentId: docId,
          hash,
          content,
          createdAt: new Date().toISOString(),
        };

        await db.createDocumentVersion(version);

        // Only create CREATED change record if not a baseline run
        if (!isBaselineRun) {
          const reason: ChangeReason = {};
          const changeRecord: ChangeRecord = {
            id: googleDriveService.generateId(),
            documentId: docId,
            newVersionId: versionId,
            changeType: 'created',
            detectedAt: new Date().toISOString(),
            summary: `Document "${file.name}" added to the system`,
            reason: JSON.stringify(reason),
            severity: 'medium',
          };

          await db.createChangeRecord(changeRecord);
          queueExplanation(changeRecord, file.name, undefined, content);
          changesDetected++;
        }
      } else {
        // Document exists - check if it was previously deleted (reappeared)
        if (document.isDeleted) {
          console.log(`  🔄 Document reappeared: ${file.name}`);
          await db.updateDocument(document.id, { isDeleted: false, deletedAt: undefined } as any);
          
          if (!isBaselineRun) {
            const reason: ChangeReason = {};
            const changeRecord: ChangeRecord = {
              id: googleDriveService.generateId(),
              documentId: document.id,
              newVersionId: document.currentVersionId,
              changeType: 'created',
              detectedAt: new Date().toISOString(),
              summary: `Document "${file.name}" reappeared in the folder`,
              reason: JSON.stringify(reason),
              severity: 'medium',
            };
            await db.createChangeRecord(changeRecord);
            queueExplanation(changeRecord, file.name, undefined, content);
            changesDetected++;
          }
        }

        // Check for rename and/or content change
        const renamed = file.name !== document.fileName;
        const contentChanged = hash !== document.currentHash;

        if (renamed) {
          console.log(`  🏷️  Rename detected: "${document.fileName}" -> "${file.name}"`);
          const reason: ChangeReason = {
            nameChanged: true,
            oldName: document.fileName,
            newName: file.name,
          };
          const renameRecord: ChangeRecord = {
            id: googleDriveService.generateId(),
            documentId: document.id,
            newVersionId: document.currentVersionId,
            changeType: 'renamed',
            detectedAt: new Date().toISOString(),
            summary: `Document renamed from "${document.fileName}" to "${file.name}"`,
            reason: JSON.stringify(reason),
            severity: 'low',
          };
          await db.createChangeRecord(renameRecord);
          queueExplanation(renameRecord, file.name);
          await db.updateDocument(document.id, { fileName: file.name, lastModified: file.modifiedTime });
          changesDetected++;
        }

        if (contentChanged) {
          console.log(`  ✏️  Content change detected: ${file.name}`);
          const versionId = googleDriveService.generateId();

          const version: DocumentVersion = {
            id: versionId,
            documentId: document.id,
            hash,
            content,
            createdAt: new Date().toISOString(),
          };

          await db.createDocumentVersion(version);

          const reason: ChangeReason = {
            contentChanged: true,
          };
          const changeRecord: ChangeRecord = {
            id: googleDriveService.generateId(),
            documentId: document.id,
            previousVersionId: document.currentVersionId,
            newVersionId: versionId,
            changeType: 'modified',
            detectedAt: new Date().toISOString(),
            summary: `Document "${file.name}" content has changed`,
            reason: JSON.stringify(reason),
            severity: 'high',
          };

          await db.createChangeRecord(changeRecord);
          
          // For modified, fetch previous content for diff
          const prevVersion = document.currentVersionId ? await db.getDocumentVersion(document.currentVersionId) : null;
          queueExplanation(changeRecord, file.name, prevVersion?.content, content);

          await db.updateDocument(document.id, {
            currentVersionId: versionId,
            currentHash: hash,
            lastModified: file.modifiedTime,
          });

          changesDetected++;
        }
      }
    }

    // DELETION DETECTION: Find documents that are in DB but not in current folder listing
    const activeDocuments = await db.getActiveDocuments();
    let deletedCount = 0;
    for (const doc of activeDocuments) {
      if (!currentDriveIds.has(doc.googleDriveId)) {
        console.log(`  🗑️  Deletion detected: ${doc.fileName} (no longer in folder)`);
        const now = new Date().toISOString();
        
        const reason: ChangeReason = {
          lastSeenAt: doc.lastModified,
          lastKnownName: doc.fileName,
        };
        const deleteRecord: ChangeRecord = {
          id: googleDriveService.generateId(),
          documentId: doc.id,
          previousVersionId: doc.currentVersionId,
          changeType: 'deleted',
          detectedAt: now,
          summary: `Document "${doc.fileName}" removed from folder or deleted`,
          reason: JSON.stringify(reason),
          severity: 'medium',
        };
        await db.createChangeRecord(deleteRecord);
        queueExplanation(deleteRecord, doc.fileName);
        await db.updateDocument(doc.id, { isDeleted: true, deletedAt: now } as any);
        
        changesDetected++;
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      console.log(`📊 Deletion detection: ${deletedCount} documents marked as deleted`);
    }

    // Create baseline summary record if this was a baseline run
    if (isBaselineRun && docsProcessed > 0) {
      const reason: ChangeReason = {
        baselineDocCount: docsProcessed,
      };
      const baselineRecord: ChangeRecord = {
        id: googleDriveService.generateId(),
        // documentId is undefined/null for system-level baseline records
        changeType: 'baseline',
        detectedAt: new Date().toISOString(),
        summary: `Baseline established: ${docsProcessed} documents indexed`,
        reason: JSON.stringify(reason),
        severity: 'low',
      };
      await db.createChangeRecord(baselineRecord);
      queueExplanation(baselineRecord);
      changesDetected = 1;
      console.log(`📋 Baseline record created: ${docsProcessed} documents indexed`);
    }

    await db.updateIngestionRun(runId, {
      status: 'completed',
      documentsProcessed: docsProcessed,
      changesDetected,
    });
  } catch (error) {
    console.error('Ingestion error:', error);
    await db.updateIngestionRun(runId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// Content extraction - exports actual text for Google Docs
async function extractContent(file: any): Promise<string> {
  try {
    if (file.mimeType === 'application/vnd.google-apps.document') {
      const text = await googleDriveService.exportGoogleDocText(file.id);
      console.log(`  📝 Exported Google Doc: ${file.name} (${text?.length ?? 0} chars)`);
      return text ?? '';
    }

    if (file.mimeType === 'application/pdf') return '[PDF Placeholder]';
    if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      return '[DOCX Placeholder]';
  } catch (error) {
    console.error(`Error extracting content from ${file.id}:`, error);
  }

  return '';
}

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`TrainLoop backend running on http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API endpoints ready`);
});
