import { googleDriveService } from './services/googleDrive';
import { db } from './db';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URL || 'http://localhost:5000/auth/callback';

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export class AuthManager {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private refreshToken: string | null = null;
  private initialized = false;
  private refreshing = false;

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
    await this.setAccessToken(data.access_token, data.refresh_token);
    return data;
  }

  async setAccessToken(token: string, refreshToken?: string): Promise<void> {
    this.accessToken = token;
    this.tokenExpiry = Date.now() + 3600000; // 1 hour expiry
    if (refreshToken) {
      this.refreshToken = refreshToken;
    }
    googleDriveService.setAccessToken(token);
    
    // Persist to database
    try {
      await db.saveAccessToken(token, this.tokenExpiry, refreshToken);
      console.log('✅ Google Drive access token set (expires in ~1 hour)');
      console.log(`   Token preview: ${token.substring(0, 20)}...`);
      if (refreshToken) console.log('💾 Refresh token saved');
      console.log('💾 Token persisted to database');
    } catch (error) {
      console.error('⚠️  Failed to persist token:', error);
    }
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken || this.refreshing) {
      return false;
    }

    this.refreshing = true;
    try {
      console.log('🔄 Attempting to refresh access token...');
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: this.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      });

      if (!response.ok) {
        console.error('⚠️  Token refresh failed');
        return false;
      }

      const data = (await response.json()) as any;
      await this.setAccessToken(data.access_token, this.refreshToken);
      console.log('✅ Access token refreshed successfully');
      return true;
    } catch (error) {
      console.error('⚠️  Error refreshing token:', error);
      return false;
    } finally {
      this.refreshing = false;
    }
  }

  async loadAccessTokenFromDatabase(): Promise<void> {
    if (this.initialized) return;
    
    try {
      const stored = await db.loadAccessToken();
      if (stored) {
        this.refreshToken = stored.refreshToken;
        if (stored.expiryTime > Date.now()) {
          this.accessToken = stored.token;
          this.tokenExpiry = stored.expiryTime;
          googleDriveService.setAccessToken(stored.token);
          console.log('✅ Loaded persistent Google Drive access token from database');
          console.log(`   Token preview: ${stored.token.substring(0, 20)}...`);
          console.log(`   Expires in: ${Math.floor((stored.expiryTime - Date.now()) / 60000)} minutes`);
        } else if (this.refreshToken) {
          console.log('⚠️  Stored token has expired, attempting refresh...');
          await this.refreshAccessToken();
        } else {
          console.log('⚠️  Stored token has expired and no refresh token available');
        }
      }
    } catch (error) {
      console.error('⚠️  Failed to load token from database:', error);
    }
    
    this.initialized = true;
  }

  async getAccessToken(): Promise<string | null> {
    if (!this.accessToken) {
      console.warn('⚠️  No access token stored');
      return null;
    }
    
    // Check if token is expired or about to expire (within 5 minutes)
    if (Date.now() >= this.tokenExpiry - 300000) {
      console.warn('⚠️  Access token expired or expiring soon');
      if (await this.refreshAccessToken()) {
        return this.accessToken;
      }
      this.accessToken = null;
      return null;
    }
    
    return this.accessToken;
  }

  async isAuthenticated(): Promise<boolean> {
    const token = await this.getAccessToken();
    if (token) {
      console.log(`✅ Authenticated with token: ${token.substring(0, 20)}...`);
    }
    return token !== null;
  }
}

export const authManager = new AuthManager();
