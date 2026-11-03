import { Router } from 'express';
import claimsRouter from './claims.js';
import pledgesRouter from './pledges.js';
import assignmentsRouter from './assignments.js';
import shoppingCardsRouter from './shopping-cards.js';
import viewsRouter from './views.js';
import offlineSyncRouter from './offline-sync.js';

const router = Router();

router.use(claimsRouter);
router.use(pledgesRouter);
router.use(assignmentsRouter);
router.use(shoppingCardsRouter);
router.use(viewsRouter);
router.use(offlineSyncRouter);

export default router;
