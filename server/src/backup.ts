import db from './db';
import path from 'path';
import fs from 'fs';

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const MAX_BACKUPS = 20;

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}_${h}${min}${s}`;
}

export function listBackups(): { filename: string; size: number; created_at: string }[] {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('portfolio_') && f.endsWith('.db'))
    .sort()
    .reverse();

  return files.map(f => {
    const stat = fs.statSync(path.join(BACKUP_DIR, f));
    return {
      filename: f,
      size: stat.size,
      created_at: stat.mtime.toISOString(),
    };
  });
}

export async function createBackup(label?: string): Promise<{ filename: string; size: number }> {
  const timestamp = formatTimestamp(new Date());
  const suffix = label ? `_${label}` : '';
  const filename = `portfolio_${timestamp}${suffix}.db`;
  const dest = path.join(BACKUP_DIR, filename);

  await db.backup(dest);

  const stat = fs.statSync(dest);

  // Clean up old backups beyond MAX_BACKUPS
  pruneBackups();

  return { filename, size: stat.size };
}

export function restoreBackup(filename: string): void {
  const src = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(src)) {
    throw new Error(`Backup file not found: ${filename}`);
  }

  // Validate it's a real sqlite file
  const header = Buffer.alloc(16);
  const fd = fs.openSync(src, 'r');
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);
  if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
    throw new Error('Invalid backup file');
  }

  const dbPath = path.join(__dirname, '..', 'portfolio.db');

  // Close current WAL/SHM by checkpointing
  db.pragma('wal_checkpoint(TRUNCATE)');

  // Copy backup over the current database
  fs.copyFileSync(src, dbPath);

  // Remove WAL and SHM files so the db reopens cleanly
  const walPath = dbPath + '-wal';
  const shmPath = dbPath + '-shm';
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
}

export function deleteBackup(filename: string): void {
  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Backup file not found: ${filename}`);
  }
  fs.unlinkSync(filePath);
}

function pruneBackups(): void {
  const backups = listBackups();
  if (backups.length > MAX_BACKUPS) {
    const toDelete = backups.slice(MAX_BACKUPS);
    for (const b of toDelete) {
      const filePath = path.join(BACKUP_DIR, b.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }
}

// Schedule automatic backup every hour
let intervalId: ReturnType<typeof setInterval> | null = null;

export function startAutoBackup(intervalMs = 60 * 60 * 1000): void {
  // Backup on startup
  createBackup('auto').catch(err => console.error('Auto backup failed:', err));

  intervalId = setInterval(() => {
    createBackup('auto').catch(err => console.error('Auto backup failed:', err));
  }, intervalMs);

  console.log(`Auto backup enabled (every ${intervalMs / 60000} minutes)`);
}

export function stopAutoBackup(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
