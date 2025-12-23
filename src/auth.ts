import { googleDriveService } from './services/googleDrive';
import { db } from './db';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URL || 'http://localhost:5000/auth/callback';

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export class AuthManager {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private refreshToken: string | null = null;
  private initialized = false;

  getAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      access_type: 'offline',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<GoogleTokenResponse> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Failed to exchange code for token: ${response.statusText}`);
    }

    const data = (await response.json()) as any;
    await this.setAccessToken(data.access_token);
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
      console.log('✅ Refresh token stored for token renewal');
    }
    return data;
  }

  async setAccessToken(token: string): Promise<void> {
    this.accessToken = token;
    this.tokenExpiry = Date.now() + 3600000; // 1 hour expiry
    googleDriveService.setAccessToken(token);
    
    // Persist to database
    try {
      await db.saveAccessToken(token, this.tokenExpiry);
      console.log('✅ Google Drive access token set (expires in ~1 hour)');
      console.log(`   Token preview: ${token.substring(0, 20)}...`);
      console.log('💾 Token persisted to database');
    } catch (error) {
      console.error('⚠️  Failed to persist token:', error);
    }
  }

  async loadAccessTokenFromDatabase(): Promise<void> {
    if (this.initialized) return;
    
    try {
      const stored = await db.loadAccessToken();
      if (stored && stored.expiryTime > Date.now()) {
        this.accessToken = stored.token;
        this.tokenExpiry = stored.expiryTime;
        googleDriveService.setAccessToken(stored.token);
        console.log('✅ Loaded persistent Google Drive access token from database');
        console.log(`   Token preview: ${stored.token.substring(0, 20)}...`);
        console.log(`   Expires in: ${Math.floor((stored.expiryTime - Date.now()) / 60000)} minutes`);
      } else if (stored) {
        console.log('⚠️  Stored token has expired');
      }
    } catch (error) {
      console.error('⚠️  Failed to load token from database:', error);
    }
    
    this.initialized = true;
  }

  getAccessToken(): string | null {
    if (!this.accessToken) {
      console.warn('⚠️  No access token stored');
      return null;
    }
    
    if (Date.now() >= this.tokenExpiry) {
      console.warn('⚠️  Access token expired');
      this.accessToken = null;
      return null;
    }
    
    return this.accessToken;
  }

  isAuthenticated(): boolean {
    const token = this.getAccessToken();
    if (token) {
      console.log(`✅ Authenticated with token: ${token.substring(0, 20)}...`);
    }
    return token !== null;
  }
}

export const authManager = new AuthManager();
