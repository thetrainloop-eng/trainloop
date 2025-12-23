import "dotenv/config"
import { google } from "googleapis";
import { getOAuthClient, saveTokens } from "./googleAuth";
import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { googleDriveService } from './services/googleDrive';
import { authManager } from './auth';
import { ChangeRecord, DocumentVersion, IngestionRun } from './types';
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

// Initialize database and load persistent auth token
(async () => {
  try {
    await db.initialize();
    await authManager.loadAccessTokenFromDatabase();
  } catch (error) {
    console.error('Failed to initialize:', error);
  }
})();

// List Drive Files
app.get("/drive/files", async (req, res) => {
  try {
    if (!authManager.isAuthenticated()) {
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
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    googleDriveConnected: authManager.isAuthenticated(),
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

// Ingestion logic
async function startIngestion(runId: string, googleDriveFolderId: string): Promise<void> {
  try {
    console.log(`\n🚀 Starting ingestion run ${runId} for folder ${googleDriveFolderId}`);
    
    // Check if authenticated
    if (!authManager.isAuthenticated()) {
      console.error('❌ Not authenticated with Google Drive. Cannot start ingestion.');
      await db.updateIngestionRun(runId, {
        status: 'failed',
        error: 'Not authenticated with Google Drive',
      });
      return;
    }
    
    await db.updateIngestionRun(runId, { status: 'in_progress' });

    // Fetch files from Google Drive folder
    console.log('📥 Fetching files from Google Drive...');
    const files = await googleDriveService.listFiles(googleDriveFolderId);
    console.log(`📦 Received ${files.length} files from Google Drive`);

    if (files.length === 0) {
      await db.updateIngestionRun(runId, {
        status: 'completed',
        documentsProcessed: 0,
        changesDetected: 0,
      });
      return;
    }

    let changesDetected = 0;

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

      // Download and extract content (placeholder)
      const content = await extractContent(file);

      if (!content) {
        continue;
      }

      // Compute hash
      const hash = file.md5Checksum ?? googleDriveService.computeHash(content);

      // Check if document exists
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

        const changeRecord: ChangeRecord = {
          id: googleDriveService.generateId(),
          documentId: docId,
          newVersionId: versionId,
          changeType: 'created',
          detectedAt: new Date().toISOString(),
          summary: `Document "${file.name}" added to the system`,
        };

        await db.createChangeRecord(changeRecord);
        changesDetected++;
      } else if (hash !== document.currentHash) {
        // Document modified
        const versionId = googleDriveService.generateId();

        const version: DocumentVersion = {
          id: versionId,
          documentId: document.id,
          hash,
          content,
          createdAt: new Date().toISOString(),
        };

        await db.createDocumentVersion(version);

        const changeRecord: ChangeRecord = {
          id: googleDriveService.generateId(),
          documentId: document.id,
          previousVersionId: document.currentVersionId,
          newVersionId: versionId,
          changeType: 'modified',
          detectedAt: new Date().toISOString(),
          summary: `Document "${file.name}" content has changed`,
        };

        await db.createChangeRecord(changeRecord);

        await db.updateDocument(document.id, {
          currentVersionId: versionId,
          currentHash: hash,
          lastModified: file.modifiedTime,
        });

        changesDetected++;
      }
    }

    await db.updateIngestionRun(runId, {
      status: 'completed',
      documentsProcessed: files.length,
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

// Modified content extraction
async function extractContent(file: any): Promise<string> {
  try {
    // Google Docs: export real text content
    if (file.mimeType === 'application/vnd.google-apps.document') {
      const text = await googleDriveService.exportGoogleDocText(file.id);
      return text ?? '';
    }

    // PDF placeholder (content parsing later)
    if (file.mimeType === 'application/pdf') {
      return '[PDF Content Placeholder]';
    }

    // DOCX placeholder (content parsing later)
    if (
      file.mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      return '[DOCX Content Placeholder]';
    }
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
