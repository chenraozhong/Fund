import { Router, Request, Response } from 'express';
import { listBackups, createBackup, restoreBackup, deleteBackup } from '../backup';

const router = Router();

// List all backups
router.get('/', (_req: Request, res: Response) => {
  const backups = listBackups();
  res.json(backups);
});

// Create a manual backup
router.post('/', async (_req: Request, res: Response) => {
  try {
    const result = await createBackup('manual');
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Restore from a backup
router.post('/restore', (req: Request, res: Response) => {
  const { filename } = req.body;
  if (!filename) {
    res.status(400).json({ error: 'filename is required' });
    return;
  }
  try {
    restoreBackup(filename);
    res.json({ success: true, message: 'Database restored. Please restart the server.' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a backup
router.delete('/:filename', (req: Request, res: Response) => {
  try {
    deleteBackup(req.params.filename as string);
    res.json({ success: true });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

export default router;
