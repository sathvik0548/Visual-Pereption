const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');
const METRICS_FILE = path.join(LOGS_DIR, 'metrics.log');

// Ensure directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function logMetric(task, actionResult, latencyMs) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    task,
    action: actionResult,
    latencyMs
  };
  
  fs.appendFileSync(METRICS_FILE, JSON.stringify(logEntry) + '\n', 'utf8');
}

module.exports = { logMetric };
