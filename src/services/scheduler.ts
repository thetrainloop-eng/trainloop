import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';

export interface SchedulerConfig {
  enabled: boolean;
  intervalMinutes: number;
  folderId: string | null;
  lastRun: string | null;
  nextRun: string | null;
}

export type IngestionCallback = (runId: string, folderId: string) => Promise<void>;

class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private config: SchedulerConfig = {
    enabled: false,
    intervalMinutes: 60,
    folderId: process.env.DRIVE_FOLDER_ID || null,
    lastRun: null,
    nextRun: null,
  };
  private ingestionCallback: IngestionCallback | null = null;
  private ingestionInProgress = false;

  async initialize(): Promise<void> {
    const savedConfig = await db.getSchedulerConfig();
    if (savedConfig) {
      this.config = { ...this.config, ...savedConfig };
    }
    
    if (this.config.enabled && this.config.folderId) {
      this.start();
    }
    
    console.log(`📅 Scheduler initialized: ${this.config.enabled ? 'ENABLED' : 'disabled'} (every ${this.config.intervalMinutes} minutes)`);
  }

  setIngestionCallback(callback: IngestionCallback): void {
    this.ingestionCallback = callback;
  }

  getConfig(): SchedulerConfig {
    return { ...this.config };
  }

  async updateConfig(updates: Partial<SchedulerConfig>): Promise<SchedulerConfig> {
    this.config = { ...this.config, ...updates };
    await db.saveSchedulerConfig(this.config);
    
    if (this.config.enabled && this.config.folderId) {
      this.start();
    } else {
      this.stop();
    }
    
    return this.getConfig();
  }

  start(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    if (!this.config.folderId) {
      console.warn('⚠️  Cannot start scheduler: No folder ID configured');
      return;
    }

    const intervalMs = this.config.intervalMinutes * 60 * 1000;
    this.config.enabled = true;
    this.config.nextRun = new Date(Date.now() + intervalMs).toISOString();

    console.log(`📅 Scheduler started: Running every ${this.config.intervalMinutes} minutes`);
    console.log(`   Next run: ${this.config.nextRun}`);

    this.timer = setInterval(() => {
      this.runScheduledIngestion();
    }, intervalMs);

    db.saveSchedulerConfig(this.config).catch(console.error);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.config.enabled = false;
    this.config.nextRun = null;
    console.log('📅 Scheduler stopped');
    db.saveSchedulerConfig(this.config).catch(console.error);
  }

  isIngestionRunning(): boolean {
    return this.ingestionInProgress;
  }

  async runNow(): Promise<{ runId: string | null; error?: string }> {
    if (!this.config.folderId) {
      console.warn('⚠️  Cannot run ingestion: No folder ID configured');
      return { runId: null, error: 'No folder ID configured' };
    }
    if (this.ingestionInProgress) {
      console.warn('⚠️  Cannot run ingestion: Another ingestion is already in progress');
      return { runId: null, error: 'Ingestion already in progress' };
    }
    return this.runScheduledIngestion();
  }

  private async runScheduledIngestion(): Promise<{ runId: string | null; error?: string }> {
    if (!this.config.folderId || !this.ingestionCallback) {
      return { runId: null, error: 'Not configured' };
    }

    if (this.ingestionInProgress) {
      console.log('⏭️  Skipping scheduled ingestion: Previous run still in progress');
      return { runId: null, error: 'Previous ingestion still running' };
    }

    const runId = uuidv4();
    console.log(`\n⏰ Scheduled ingestion triggered: ${runId}`);

    this.ingestionInProgress = true;
    try {
      this.config.lastRun = new Date().toISOString();
      if (this.config.enabled) {
        this.config.nextRun = new Date(Date.now() + this.config.intervalMinutes * 60 * 1000).toISOString();
      }
      await db.saveSchedulerConfig(this.config);

      await this.ingestionCallback(runId, this.config.folderId);
      return { runId };
    } catch (error) {
      console.error('❌ Scheduled ingestion failed:', error);
      return { runId: null, error: String(error) };
    } finally {
      this.ingestionInProgress = false;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}

export const schedulerService = new SchedulerService();
