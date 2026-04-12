import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import { protect } from '../middleware/auth.js';

export const uploadRoutes = express.Router();

const uploadDir = process.env.UPLOAD_DIR || 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ext || '.jpg';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

uploadRoutes.post('/image', protect, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'file required' });

  const baseUrl = process.env.UPLOAD_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const url = `${normalizedBase}/uploads/${req.file.filename}`;
  res.status(201).json({
    filename: req.file.filename,
    url,
    path: req.file.path,
  });
});
