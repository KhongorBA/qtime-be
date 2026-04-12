import express from 'express';
import { requireAdmin } from '../../middleware/requireAdmin.js';
import { usersRouter } from './users.js';
import { businessesRouter } from './businesses.js';
import { analyticsRouter } from './analytics.js';
import { paymentsRouter } from './payments.js';
import { reviewsRouter } from './reviews.js';
import { contentRouter } from './content.js';
import { notificationsRouter } from './notifications.js';
import { receiptsRouter } from './receipts.js';
import { csvRouter } from './csv.js';

const adminRouter = express.Router();

adminRouter.use(requireAdmin);

adminRouter.use('/users', usersRouter);
adminRouter.use('/businesses', businessesRouter);
adminRouter.use('/analytics', analyticsRouter);
adminRouter.use('/payments', paymentsRouter);
adminRouter.use('/reviews', reviewsRouter);
adminRouter.use('/content', contentRouter);
adminRouter.use('/notifications', notificationsRouter);
adminRouter.use('/receipts', receiptsRouter);
adminRouter.use('/csv', csvRouter);

export { adminRouter };
