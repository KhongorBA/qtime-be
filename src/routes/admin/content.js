import express from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../../config/db.js';

export const contentRouter = express.Router();

// GET /api/admin/content - app контент
contentRouter.get('/', async (req, res) => {
  try {
    const items = await prisma.appContent.findMany({ orderBy: { key: 'asc' } });
    const map = Object.fromEntries(items.map((i) => [i.key, i.value]));
    res.json(map);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/admin/content - контент засах
contentRouter.put(
  '/',
  [body('key').trim().notEmpty(), body('value')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { key, value } = req.body;
      const item = await prisma.appContent.upsert({
        where: { key },
        create: { key, value: String(value ?? '') },
        update: { value: String(value ?? '') },
      });
      res.json(item);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);
