import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// Placeholder for Google Drive service
// Will be properly integrated after setting up Google Drive connector
export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

export class GoogleDriveService {
  private accessToken: string | null = null;

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  async listFiles(folderId: string): Promise<GoogleDriveFile[]> {
    const allFiles: GoogleDriveFile[] = [];
    await this.recursiveListFiles(folderId, allFiles);
    return allFiles;
  }

  private async recursiveListFiles(folderId: string, accumulator: GoogleDriveFile[]): Promise<void> {
    if (!this.accessToken) {
      console.error('❌ Google Drive access token not set. Cannot list files.');
      return;
    }

    try {
      const query = `'${folderId}' in parents and trashed=false`;
      const fieldsParam = 'files(id,name,mimeType,modifiedTime)';
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&spaces=drive&fields=${encodeURIComponent(fieldsParam)}`;
      
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`❌ Google Drive API error: ${response.status} ${response.statusText}`);
        console.error(`Response: ${errorBody}`);
        throw new Error(`Google Drive API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as any;
      const files = data.files || [];
      
      for (const file of files) {
        // If it's a folder, recurse into it
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          console.log(`📁 Recursing into folder: ${file.name}`);
          await this.recursiveListFiles(file.id, accumulator);
        } else {
          // Add document files
          accumulator.push(file);
          console.log(`  📄 Found: ${file.name} (${file.mimeType})`);
        }
      }
    } catch (error) {
      console.error('❌ Error listing Google Drive files:', error);
    }
  }

  async downloadFile(fileId: string): Promise<Buffer | null> {
    if (!this.accessToken) {
      console.warn('Google Drive access token not set.');
      return null;
    }

    try {
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Google Drive API error: ${response.statusText}`);
      }

      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      console.error('Error downloading from Google Drive:', error);
      return null;
    }
  }

  computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  generateId(): string {
    return uuidv4();
  }
}

export const googleDriveService = new GoogleDriveService();
