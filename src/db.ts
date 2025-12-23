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
        createdAt TEXT NOT NULL
      )
    `);

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

    // Change records table
    await run(`
      CREATE TABLE IF NOT EXISTS change_records (
        id TEXT PRIMARY KEY,
        documentId TEXT NOT NULL,
        previousVersionId TEXT,
        newVersionId TEXT NOT NULL,
        changeType TEXT NOT NULL,
        detectedAt TEXT NOT NULL,
        summary TEXT,
        FOREIGN KEY (documentId) REFERENCES documents(id),
        FOREIGN KEY (previousVersionId) REFERENCES document_versions(id),
        FOREIGN KEY (newVersionId) REFERENCES document_versions(id)
      )
    `);

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
      `INSERT INTO change_records (id, documentId, previousVersionId, newVersionId, changeType, detectedAt, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    return new Promise((resolve, reject) => {
      stmt.run(record.id, record.documentId, record.previousVersionId, record.newVersionId, record.changeType, record.detectedAt, record.summary, function(err: Error | null) {
        if (err) reject(err);
        else resolve();
      });
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

  close(): void {
    this.db.close();
  }
}

export const db = new Database();
