const fs = require('fs');
const path = require('path');

const IS_VERCEL = !!process.env.VERCEL;

const LOG_DIR = path.join(__dirname, '../logs');
const LOG_FILE = path.join(LOG_DIR, `app-${new Date().toISOString().split('T')[0]}.log`);
const ERROR_LOG_FILE = path.join(LOG_DIR, `error-${new Date().toISOString().split('T')[0]}.log`);

// Create logs directory if it doesn't exist (only if not on Vercel)
if (!IS_VERCEL && !fs.existsSync(LOG_DIR)) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create logs directory:', err);
  }
}

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

function formatLog(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length > 0 ? ` | ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level}] ${message}${metaStr}\n`;
}

function writeToFile(filePath, content) {
  if (IS_VERCEL) return;
  try {
    fs.appendFileSync(filePath, content, 'utf8');
  } catch (err) {
    console.error('Failed to write to log file:', err);
  }
}

function log(level, message, meta = {}) {
  const levelValue = LOG_LEVELS[level];

  if (levelValue < CURRENT_LOG_LEVEL) {
    return;
  }

  const logEntry = formatLog(level, message, meta);

  // Write to console
  if (level === 'ERROR') {
    console.error(logEntry.trim());
  } else if (level === 'WARN') {
    console.warn(logEntry.trim());
  } else {
    console.log(logEntry.trim());
  }

  // Write to file
  writeToFile(LOG_FILE, logEntry);

  // Write errors to separate error log
  if (level === 'ERROR') {
    writeToFile(ERROR_LOG_FILE, logEntry);
  }
}

const logger = {
  debug: (message, meta) => log('DEBUG', message, meta),
  info: (message, meta) => log('INFO', message, meta),
  warn: (message, meta) => log('WARN', message, meta),
  error: (message, meta) => log('ERROR', message, meta),
};

module.exports = logger;
