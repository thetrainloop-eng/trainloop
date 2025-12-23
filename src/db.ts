import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { IngestionRun, Document, DocumentVersion, ChangeRecord } from './types';

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'trainloop.db');

export class Database {
  private db: sqlite3.Database;

  constructor() {
    this.db = new sqlite3.Database(dbPath);
    this.db.configure('busyTimeout', 5000);
  }

  async initialize(): Promise<void> {
    const run = (sql: string) => new Promise<void>((resolve, reject) => {
      this.db.run(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Ingestion runs table
    await run(`
      CREATE TABLE IF NOT EXISTS ingestion_runs (
        id TEXT PRIMARY KEY,
        createdAt TEXT NOT NULL,
        status TEXT NOT NULL,
        documentsProcessed INTEGER DEFAULT 0,
        changesDetected INTEGER DEFAULT 0,
        error TEXT
      )
    `);

    // Documents table
    await run(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        googleDriveId TEXT UNIQUE NOT NULL,
        fileName TEXT NOT NULL,
        mimeType TEXT NOT NULL,
        lastModified TEXT NOT NULL,
        currentVersionId TEXT,
        currentHash TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        isDeleted INTEGER DEFAULT 0,
        deletedAt TEXT
      )
    `);

    // Add columns if they don't exist (for existing DBs)
    await run(`ALTER TABLE documents ADD COLUMN isDeleted INTEGER DEFAULT 0`).catch(() => {});
    await run(`ALTER TABLE documents ADD COLUMN deletedAt TEXT`).catch(() => {});

    // Document versions table
    await run(`
      CREATE TABLE IF NOT EXISTS document_versions (
        id TEXT PRIMARY KEY,
        documentId TEXT NOT NULL,
        hash TEXT NOT NULL,
        content TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (documentId) REFERENCES documents(id)
      )
    `);

    // Change records table (documentId can be NULL for system-level records like baseline)
    await run(`
      CREATE TABLE IF NOT EXISTS change_records (
        id TEXT PRIMARY KEY,
        documentId TEXT,
        previousVersionId TEXT,
        newVersionId TEXT,
        changeType TEXT NOT NULL,
        detectedAt TEXT NOT NULL,
        summary TEXT,
        reason TEXT,
        severity TEXT,
        FOREIGN KEY (documentId) REFERENCES documents(id),
        FOREIGN KEY (previousVersionId) REFERENCES document_versions(id),
        FOREIGN KEY (newVersionId) REFERENCES document_versions(id)
      )
    `);

    // Add columns if they don't exist (for existing DBs)
    await run(`ALTER TABLE change_records ADD COLUMN reason TEXT`).catch(() => {});
    await run(`ALTER TABLE change_records ADD COLUMN severity TEXT`).catch(() => {});

    // Auth tokens table (stores Google OAuth token)
    await run(`
      CREATE TABLE IF NOT EXISTS auth_tokens (
        key TEXT PRIMARY KEY,
        accessToken TEXT,
        refreshToken TEXT,
        expiryTime INTEGER,
        updatedAt TEXT NOT NULL
      )
    `);

    // Scheduler config table
    await run(`
      CREATE TABLE IF NOT EXISTS scheduler_config (
        key TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        intervalMinutes INTEGER DEFAULT 60,
        folderId TEXT,
        lastRun TEXT,
        nextRun TEXT,
        updatedAt TEXT NOT NULL
      )
    `);
  }

  async saveAccessToken(accessToken: string, expiryTime: number, refreshToken?: string): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO auth_tokens (key, accessToken, refreshToken, expiryTime, updatedAt)
       VALUES ('google_oauth', ?, ?, ?, ?)`
    );
    return new Promise((resolve, reject) => {
      stmt.run(accessToken, refreshToken || null, expiryTime, new Date().toISOString(), function(err: Error | null) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async loadAccessToken(): Promise<{ token: string; refreshToken: string | null; expiryTime: number } | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT accessToken, refreshToken, expiryTime FROM auth_tokens WHERE key = 'google_oauth'`,
        (err, row: any) => {
          if (err) reject(err);
          else if (row) resolve({ token: row.accessToken, refreshToken: row.refreshToken, expiryTime: row.expiryTime });
          else resolve(null);
        }
      );
    });
  }

  async createIngestionRun(run: IngestionRun): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO ingestion_runs (id, createdAt, status, documentsProcessed, changesDetected, error)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    return new Promise((resolve, reject) => {
      stmt.run(run.id, run.createdAt, run.status, run.documentsProcessed, run.changesDetected, run.error, function(err: Error | null) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async updateIngestionRun(id: string, updates: Partial<IngestionRun>): Promise<void> {
    const fields = Object.keys(updates)
      .filter(k => k !== 'id')
      .map(k => `${k} = ?`)
      .join(', ');
    const values = Object.keys(updates)
      .filter(k => k !== 'id')
      .map(k => updates[k as keyof IngestionRun]);

    const stmt = this.db.prepare(`UPDATE ingestion_runs SET ${fields} WHERE id = ?`);
    return new Promise((resolve, reject) => {
      stmt.run(...values, id, function(err: Error | null) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async getIngestionRuns(): Promise<IngestionRun[]> {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT * FROM ingestion_runs ORDER BY createdAt DESC', (err, rows) => {
        if (err) reject(err);
        else resolve((rows as any[]) || []);
      });
    });
  }

  async createDocument(doc: Document): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO documents (id, googleDriveId, fileName, mimeType, lastModified, currentVersionId, currentHash, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    return new Promise((resolve, reject) => {
      stmt.run(doc.id, doc.googleDriveId, doc.fileName, doc.mimeType, doc.lastModified, doc.currentVersionId, doc.currentHash, new Date().toISOString(), function(err: Error | null) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async updateDocument(id: string, updates: Partial<Document>): Promise<void> {
    const fields = Object.keys(updates)
      .filter(k => k !== 'id')
      .map(k => `${k} = ?`)
      .join(', ');
    const values = Object.keys(updates)
      .filter(k => k !== 'id')
      .map(k => updates[k as keyof Document]);

    const stmt = this.db.prepare(`UPDATE documents SET ${fields} WHERE id = ?`);
    return new Promise((resolve, reject) => {
      stmt.run(...values, id, function(err: Error | null) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async getDocumentByGoogleDriveId(googleDriveId: string): Promise<Document | null> {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM documents WHERE googleDriveId = ?', [googleDriveId], (err, row) => {
        if (err) reject(err);
        else resolve((row as Document) || null);
      });
    });
  }

  async getDocument(id: string): Promise<Document | null> {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM documents WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve((row as Document) || null);
      });
    });
  }

  async getAllDocuments(): Promise<Document[]> {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT * FROM documents', (err, rows) => {
        if (err) reject(err);
        else resolve((rows as any[]) || []);
      });
    });
  }

  async getActiveDocuments(): Promise<Document[]> {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT * FROM documents WHERE isDeleted = 0 OR isDeleted IS NULL', (err, rows) => {
        if (err) reject(err);
        else resolve((rows as any[]) || []);
      });
    });
  }

  async getActiveDocumentCount(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT COUNT(*) as count FROM documents WHERE isDeleted = 0 OR isDeleted IS NULL', (err, row: any) => {
        if (err) reject(err);
        else resolve(row?.count || 0);
      });
    });
  }

  async getTotalDocumentCount(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT COUNT(*) as count FROM documents', (err, row: any) => {
        if (err) reject(err);
        else resolve(row?.count || 0);
      });
    });
  }

  async createDocumentVersion(version: DocumentVersion): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO document_versions (id, documentId, hash, content, createdAt)
       VALUES (?, ?, ?, ?, ?)`
    );
    return new Promise((resolve, reject) => {
      stmt.run(version.id, version.documentId, version.hash, version.content, version.createdAt, function(err: Error | null) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async getDocumentVersions(documentId: string): Promise<DocumentVersion[]> {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT * FROM document_versions WHERE documentId = ? ORDER BY createdAt DESC', [documentId], (err, rows) => {
        if (err) reject(err);
        else resolve((rows as any[]) || []);
      });
    });
  }

  async getDocumentVersion(id: string): Promise<DocumentVersion | null> {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM document_versions WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve((row as DocumentVersion) || null);
      });
    });
  }

  async createChangeRecord(record: ChangeRecord): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO change_records (id, documentId, previousVersionId, newVersionId, changeType, detectedAt, summary, reason, severity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    return new Promise((resolve, reject) => {
      stmt.run(
        record.id,
        record.documentId || null, // allow NULL for system-level records (baseline)
        record.previousVersionId || null,
        record.newVersionId || null,
        record.changeType,
        record.detectedAt,
        record.summary || null,
        record.reason || null,
        record.severity || null,
        function(err: Error | null) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async getChangeRecords(documentId?: string): Promise<ChangeRecord[]> {
    const query = documentId
      ? 'SELECT * FROM change_records WHERE documentId = ? ORDER BY detectedAt DESC'
      : 'SELECT * FROM change_records ORDER BY detectedAt DESC';
    const params = documentId ? [documentId] : [];

    return new Promise((resolve, reject) => {
      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve((rows as any[]) || []);
      });
    });
  }

  async saveSchedulerConfig(config: {
    enabled: boolean;
    intervalMinutes: number;
    folderId: string | null;
    lastRun: string | null;
    nextRun: string | null;
  }): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO scheduler_config (key, enabled, intervalMinutes, folderId, lastRun, nextRun, updatedAt)
       VALUES ('default', ?, ?, ?, ?, ?, ?)`
    );
    return new Promise((resolve, reject) => {
      stmt.run(
        config.enabled ? 1 : 0,
        config.intervalMinutes,
        config.folderId,
        config.lastRun,
        config.nextRun,
        new Date().toISOString(),
        function(err: Error | null) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async getSchedulerConfig(): Promise<{
    enabled: boolean;
    intervalMinutes: number;
    folderId: string | null;
    lastRun: string | null;
    nextRun: string | null;
  } | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT enabled, intervalMinutes, folderId, lastRun, nextRun FROM scheduler_config WHERE key = 'default'`,
        (err, row: any) => {
          if (err) reject(err);
          else if (row) {
            resolve({
              enabled: row.enabled === 1,
              intervalMinutes: row.intervalMinutes,
              folderId: row.folderId,
              lastRun: row.lastRun,
              nextRun: row.nextRun,
            });
          } else {
            resolve(null);
          }
        }
      );
    });
  }

  async getLatestIngestionRun(): Promise<IngestionRun | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM ingestion_runs ORDER BY createdAt DESC LIMIT 1',
        (err, row) => {
          if (err) reject(err);
          else resolve((row as IngestionRun) || null);
        }
      );
    });
  }

  async getRecentChanges(limit: number = 20): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT cr.*, d.fileName 
         FROM change_records cr 
         LEFT JOIN documents d ON cr.documentId = d.id AND cr.changeType != 'baseline'
         ORDER BY cr.detectedAt DESC 
         LIMIT ?`,
        [limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve((rows as any[]) || []);
        }
      );
    });
  }

  close(): void {
    this.db.close();
  }
}

export const db = new Database();
