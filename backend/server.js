const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const chatbotRoutes = require('./chatbot/chatbotRoutes');
const logger = require('./utils/logger');
const transactionRoutes = require('./routes/transactionRoutes');
const qcRoutes = require('./routes/qcRoutes');
const chatRoutes = require('./routes/chatRoutes');
const rulesEngineService = require('./services/rulesEngineService');
const zohoRoutes = require('./routes/zohoRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 🔒 SECURITY: CORS Restriction
// ==========================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',').map(o => o.trim());
logger.info('CORS allowed origins', { origins: ALLOWED_ORIGINS });
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) {
      cb(null, true);
      return;
    }

    // Check exact matches
    if (ALLOWED_ORIGINS.includes(origin)) {
      cb(null, true);
      return;
    }

    // Allow all Vercel preview deployments
    if (origin.endsWith('.vercel.app')) {
      cb(null, true);
      return;
    }

    logger.warn('CORS blocked origin', { origin });
    cb(null, false);
  },
  credentials: true
}));
app.use(express.json());
app.set('trust proxy', 1);

// ==========================================
// 🔒 SECURITY: Rate Limiting
// ==========================================
const limiter = rateLimit({ windowMs: 60_000, max: 30 });
app.use('/api/transactions/categorize-bulk', limiter);
app.use('/api/transactions/upload-bulk', limiter);
app.use(express.json({ limit: '10mb' }));

// ==========================================
// 🛣️ ROUTES MOUNTING
// ==========================================
app.use('/api/transactions', transactionRoutes);
app.use('/api/qc', qcRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/zoho', zohoRoutes);

// ==========================================
// 🔒 INTERNAL: Auto-Pipeline (Python → Node)
// Called by merchant_grouping.py after grouping completes.
// Auth is handled inside the controller (INTERNAL_SECRET bearer check).
// ==========================================
const { runAutoPipeline } = require('./controllers/autoPipelineController');
app.post('/internal/auto-pipeline', express.json(), runAutoPipeline);

// ==========================================
// 🏓 KEEP-ALIVE PING
// ==========================================
app.get('/ping', (req, res) => {
  res.status(200).json({ pong: true });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'LedgerAI Backend Online' });
});

app.get('/qc', (req, res) => {
  res.status(200).send('<!DOCTYPE html><html><head><title>QC</title></head><body></body></html>');
});

// ==========================================
// 🔒 SECURITY: Global Error Handler
// ==========================================
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message
  });
});

// Load rules at startup
rulesEngineService.loadRules().then(() => {
  app.listen(PORT, () => {
    logger.info(`LedgerAI Backend running on port ${PORT}`, { port: PORT, env: process.env.NODE_ENV || 'development' });
  });
}).catch((err) => {
  logger.error('Failed to load rules at startup', { error: err.message, stack: err.stack });
  process.exit(1);
});