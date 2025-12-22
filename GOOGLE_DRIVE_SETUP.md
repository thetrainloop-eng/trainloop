# Google Drive Integration Setup Guide

Since you declined the Replit Google Drive connector, here's how to set up Google Drive integration manually using OAuth 2.0:

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown at the top
3. Click "New Project"
4. Enter name: `TrainLoop`
5. Click "Create"

## Step 2: Enable Google Drive API

1. In the Google Cloud Console, go to "APIs & Services" > "Library"
2. Search for "Google Drive API"
3. Click on it and then click "Enable"

## Step 3: Create OAuth 2.0 Credentials

1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth client ID"
3. You'll be prompted to configure the OAuth consent screen first:
   - Select "External" user type
   - Fill in app name: `TrainLoop`
   - Add your email as support contact
   - Add the same email as developer contact
   - Save and continue through scopes (no special scopes needed yet)
4. Return to Credentials, click "Create Credentials" > "OAuth client ID" again
5. Select "Web application"
6. Add Authorized redirect URIs:
   - `http://localhost:3000/auth/callback`
   - `http://localhost:5000/auth/callback` (for production)
7. Click "Create"
8. Copy your **Client ID** and **Client Secret**

## Step 4: Store Credentials in Replit

Store your Google OAuth credentials as secrets in Replit:

```
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here
```

You can set these in the "Secrets" tab in the Replit GUI, or request them through code using environment variables.

## Step 5: Get Your Google Drive Folder ID

1. Open [Google Drive](https://drive.google.com/)
2. Create or select a folder for TrainLoop documents
3. Open the folder and look at the URL: `https://drive.google.com/drive/folders/FOLDER_ID_HERE`
4. Copy the `FOLDER_ID_HERE` part - this is your folder ID

## Current Implementation

The backend currently has a placeholder `GoogleDriveService` class that can accept an access token:

```typescript
googleDriveService.setAccessToken(token);
```

### Supported Operations
- `listFiles(folderId)` - List all files in a Google Drive folder
- `downloadFile(fileId)` - Download file content
- `computeHash(content)` - Generate SHA256 hash
- `generateId()` - Generate UUID

### Supported Document Types
- PDF (`application/pdf`)
- Word Documents (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`)
- Google Docs (`application/vnd.google-apps.document`)

## Next Steps to Complete Integration

The following enhancements are needed to fully integrate Google Drive:

1. **Add OAuth flow endpoint** - Implement `/auth/google` and `/auth/callback` endpoints
2. **Token refresh logic** - Handle expired access tokens
3. **Content extraction** - Install and implement PDF/DOCX parsers:
   - `pdf-parse` for PDFs
   - `mammoth` for DOCX files
   - Google Docs Converter API for Google Docs
4. **Test the ingestion** - Use the `POST /api/ingestion-runs` endpoint

## Example: Manual Testing Without OAuth

For initial testing without completing OAuth setup, you can:

1. Download documents manually to a local folder
2. Create a local file ingestion endpoint
3. Mock the Google Drive responses

Or, provide your Google credentials and we can implement the full OAuth flow for you.

## Troubleshooting

- **"unable to open database file"** - Ensure `data/` directory exists (auto-created on startup)
- **Google Drive API errors** - Check that credentials are valid and have Google Drive API enabled
- **Access token expired** - Implement token refresh using refresh token flow

## More Resources

- [Google Drive API Documentation](https://developers.google.com/drive/api/guides/about-sdk)
- [Google OAuth 2.0 Documentation](https://developers.google.com/identity/protocols/oauth2)
