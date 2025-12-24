# TrainLoop Backend

## Overview
TrainLoop helps organizations detect policy and procedure changes and keep onboarding and training aligned.

## Project Status
**✅ Slice 1: Google Drive Ingestion & Change Tracking - COMPLETE**
**✅ Scheduled Ingestion & Dashboard - COMPLETE**
**✅ Slice 2: Plain-English Explanations - COMPLETE**

A minimal backend server for Google Drive ingestion and change tracking with the following architecture:
- **Framework**: Node.js with TypeScript and Express
- **Database**: SQLite (stored in `data/trainloop.db`)
- **Port**: 5000 (Replit webview compatible)
- **Architecture**: Async/Promise-based with modular service design

## Features Implemented

### Core Infrastructure ✅
- Express REST API server running on port 5000
- SQLite database with tables for:
  - Ingestion runs (tracking, status, results)
  - Documents (Google Drive file metadata)
  - Document versions (immutable content snapshots with SHA256 hashes)
  - Change records (immutable audit trail of content changes)
  - Auth tokens (persistent OAuth storage)

### API Endpoints ✅
- `GET /health` - Health check
- `GET /` - Landing page with auth UI
- `GET /dashboard.html` - Dashboard UI with scheduler controls and statistics
- `GET /auth/google` - Initiate Google OAuth login
- `GET /auth/callback` - OAuth callback handler
- `GET /api/ingestion-runs` - List all ingestion runs
- `POST /api/ingestion-runs` - Trigger a manual ingestion run (requires `googleDriveFolderId`)
- `GET /api/documents` - List all documents
- `GET /api/documents/:id` - Get document details with versions and change history
- `GET /api/change-records` - List all change records
- `GET /api/dashboard` - Dashboard data (auth status, stats, last run, recent changes)
- `GET /api/scheduler` - Get scheduler configuration
- `POST /api/scheduler/start` - Start scheduler (optional `intervalMinutes` and `folderId`)
- `POST /api/scheduler/stop` - Stop scheduler
- `POST /api/scheduler/run-now` - Trigger immediate ingestion (returns 409 if already running)
- `GET /api/scheduler/status` - Get scheduler status including ingestionInProgress flag

### Ingestion Process ✅
- Recursive folder traversal - finds documents in nested subdirectories
- Supports PDF, DOCX, and Google Docs formats
- Computes SHA256 hash of extracted content
- Detects changes by comparing hashes
- Creates immutable version records
- Creates change records with metadata (change type, timestamp, summary)
- Runs asynchronously in background
- **Concurrent run protection** - ingestionInProgress flag prevents overlapping runs

### Scheduled Ingestion ✅
- Configurable interval (default 60 minutes)
- Start/stop controls via API
- Persists configuration across restarts
- Automatic OAuth token refresh using refresh tokens
- Skips scheduled runs if previous ingestion still in progress

### Dashboard UI ✅
- Google Drive connection status with authenticate button
- Scheduler status and controls (Start/Stop/Run Now)
- Statistics showing total documents and recent changes
- Last ingestion details (status, time, documents processed)
- Recent changes list with document names and explanation status badges
- Expandable explanations with what changed, why it matters, and recommended actions
- Auto-refreshes every 30 seconds

### Plain-English Explanations (Slice 2) ✅
- Automatic explanation generation for every change record
- Deterministic explanations for RENAMED, BASELINE, and DELETED (no AI required)
- AI-powered explanations for CREATED, MODIFIED (when enabled)
- Feature flag: `EXPLANATIONS_ENABLED=true|false` (default: false)
- **Evidence-based MODIFIED explanations** with before/after text excerpts
- **High-risk phrase detection** for privacy/compliance language (sell, share, disclose, third party, etc.)
- Structured output with change_items containing specific changes and evidence
- Non-blocking generation (doesn't slow down ingestion)
- Graceful failure handling with fallback to deterministic explanations
- Backfill mechanism for existing records with null explanationStatus

### Google Drive Integration ✅
- OAuth 2.0 fully authenticated and persistent
- Token storage in SQLite survives server restarts
- Recursive API calls traverse folder hierarchies
- Successfully tested with real Google Drive folder containing 6 documents

## Project Structure
```
trainloop-backend/
├── src/
│   ├── index.ts                # Express server, routes, ingestion logic
│   ├── db.ts                   # SQLite database layer with async wrappers
│   ├── types.ts                # TypeScript interfaces
│   ├── auth.ts                 # Google OAuth authentication manager
│   ├── services/
│   │   ├── googleDrive.ts          # Google Drive API service with recursive traversal
│   │   ├── explanationGenerator.ts # Explanation service with swappable AI provider
│   │   └── scheduler.ts        # Scheduled ingestion service with interval timer
│   └── public/
│       ├── index.html          # Landing page with auth button
│       ├── dashboard.html      # Dashboard UI with scheduler controls
│       ├── privacy-policy.html # Required for Google OAuth consent
│       └── styles.css          # Basic styling
├── dist/                       # Compiled JavaScript (generated)
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript config
└── data/
    └── trainloop.db            # SQLite database (auto-created)
```

## Database Schema

### ingestion_runs
- `id`: UUID primary key
- `createdAt`: ISO timestamp
- `status`: pending | in_progress | completed | failed
- `documentsProcessed`: count
- `changesDetected`: count
- `error`: error message (optional)

### documents
- `id`: UUID primary key
- `googleDriveId`: unique Google Drive file ID
- `fileName`: document name
- `mimeType`: MIME type
- `lastModified`: ISO timestamp
- `currentVersionId`: foreign key to document_versions
- `currentHash`: SHA256 hash
- `createdAt`: ISO timestamp

### document_versions
- `id`: UUID primary key
- `documentId`: foreign key to documents
- `hash`: SHA256 hash of content
- `content`: extracted text content
- `createdAt`: ISO timestamp

### change_records
- `id`: UUID primary key
- `documentId`: foreign key to documents
- `previousVersionId`: optional foreign key (null for created)
- `newVersionId`: foreign key to document_versions
- `changeType`: created | modified | deleted
- `detectedAt`: ISO timestamp
- `summary`: human-readable description

### auth_tokens
- `id`: primary key
- `accessToken`: encrypted Google OAuth token
- `refreshToken`: OAuth refresh token for automatic renewal
- `expiresAt`: token expiration timestamp
- `updatedAt`: last update timestamp

### scheduler_config
- `id`: primary key
- `enabled`: boolean (scheduler on/off)
- `intervalMinutes`: ingestion frequency
- `folderId`: Google Drive folder to ingest
- `lastRun`: timestamp of last scheduled run
- `nextRun`: timestamp of next scheduled run
- `updatedAt`: last update timestamp

## Setup & Running

### Installation
```bash
npm install
```

### Development
```bash
npm run dev
```
Runs TypeScript directly with ts-node on port 5000.

### Building
```bash
npm run build
```
Compiles TypeScript to JavaScript in `dist/` folder.

### Production
```bash
npm start
```
Runs compiled JavaScript from `dist/`.

## Google Drive Integration

### How It Works
1. Click **"Authenticate with Google Drive"** button on the landing page
2. Log in with your Google account
3. Grant read-only access to Google Drive
4. Token is automatically saved to database (persists across restarts)
5. Trigger ingestion to scan folders and extract documents

### Testing Ingestion
```bash
curl -X POST http://localhost:5000/api/ingestion-runs \
  -H "Content-Type: application/json" \
  -d '{"googleDriveFolderId": "12HBjGmLhx4sAMmbnE4wCNwSTYUjkOs0J"}'
```

### Verified Test Results
✅ Successfully ingested 6 documents from test folder:
- New Hire Compliance Training Overview (Google Doc)
- Annual Security Awareness Training (PDF)
- Incident Response SOP (Google Doc)
- Customer Onboarding SOP (DOCX)
- Customer Data Privacy Policy (PDF)
- Information Security Policy (Google Doc)

All documents:
- Extracted and text indexed
- SHA256 hashes computed
- Stored with immutable versions
- Change records created

### Credentials
- **GOOGLE_CLIENT_ID**: Stored in Replit Secrets ✅
- **GOOGLE_CLIENT_SECRET**: Stored in Replit Secrets ✅

### Supported Document Types
- PDF (`application/pdf`)
- Word Documents (`.docx`) - DOCX support ready, content extraction via placeholder
- Google Docs (`application/vnd.google-apps.document`) - Content extraction working

## Implementation Notes

### Key Design Decisions
1. **Port 5000**: Replit webview requires port 5000 for frontend preview
2. **Persistent Token Storage**: OAuth tokens stored in SQLite to survive server restarts
3. **Recursive Folder Traversal**: Automatically descends into subfolder hierarchy
4. **Immutable Records**: Change records are append-only, creating complete audit trail
5. **Hash-Based Change Detection**: SHA256 enables detecting exact content changes

### Technologies Used
- **Express**: Minimal HTTP framework
- **TypeScript**: Type-safe development
- **SQLite**: Lightweight, serverless database
- **Google Drive API v3**: Official Google integration
- **UUID**: Unique identifier generation
- **crypto.hash**: SHA256 computation

## Next Steps (Beyond Slice 1)
- ❌ **Role impact analysis** - Not in Slice 1 scope
- ❌ **Training recommendations** - Not in Slice 1 scope
- ❌ **Notifications** - Not in Slice 1 scope
- ❌ **LMS integrations** - Not in Slice 1 scope

## Known Limitations (Slice 1)
- PDF/DOCX content extraction is placeholder (returns "[Format] Content") - Slice 1 focuses on infrastructure
- No pagination on API endpoints (works fine for current document counts)
- No scheduling (ingestion triggered manually)
- No filtering or search on documents
- Single-folder ingestion per request (no batch operations)

## Example Usage

### Create an ingestion run
```bash
curl -X POST http://localhost:5000/api/ingestion-runs \
  -H "Content-Type: application/json" \
  -d '{"googleDriveFolderId": "YOUR_FOLDER_ID"}'
```

### List all documents
```bash
curl http://localhost:5000/api/documents
```

### Get document with change history
```bash
curl http://localhost:5000/api/documents/{documentId}
```

### Get all change records
```bash
curl http://localhost:5000/api/change-records
```

## Dependencies
- **express**: Web framework
- **sqlite3**: Database
- **uuid**: ID generation
- **dotenv**: Environment variable management
- **typescript**: Type-safe JavaScript
- **ts-node**: Run TypeScript directly
- **@types/express**, **@types/node**, **@types/uuid**: Type definitions
