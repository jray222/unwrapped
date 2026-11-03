import { Router } from 'express';
import { registerListRoutes } from './lists.js';
import { registerItemRoutes } from './items.js';
import { registerAutofillRoutes } from './autofill.js';
import { registerImageRoutes } from './images.js';
import { registerThankYouRoutes } from './thank-you.js';

const router = Router({ mergeParams: true });

// Registration order matches the original single-file router.
registerListRoutes(router);
registerItemRoutes(router);
registerAutofillRoutes(router);
registerImageRoutes(router);
registerThankYouRoutes(router);

export default router;
