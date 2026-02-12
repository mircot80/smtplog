const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');

/**
 * SMTP Log Viewer - Backend Server
 * 
 * Parses Postfix/OpenDKIM SMTP logs and stores them in MariaDB
 * Provides REST API for frontend to query logs and email statistics
 * 
 * Features:
 * - Automatic log parsing (every hour via cron job)
 * - Manual import trigger via API endpoint
 * - Email tracking and statistics
 * - Log file auto-cleanup (truncate after import)
 * - Comprehensive error handling and logging
 * 
 * Environment Variables:
 * - DB_HOST: Database host (default: localhost)
 * - DB_PORT: Database port (default: 3306)
 * - DB_USER: Database user (default: smtplog_user)
 * - DB_PASSWORD: Database password
 * - DB_NAME: Database name (default: smtplog)
 * - PORT: Server port (default: 3000)
 * - NODE_ENV: Environment (default: production)
 */

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'smtplog_user',
  password: process.env.DB_PASSWORD || 'smtplog_password',
  database: process.env.DB_NAME || 'smtplog',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ============================================================================
// LOG STREAMING - Server-Sent Events
// ============================================================================

let sseClients = [];
let importInProgress = false;

/**
 * Add an SSE client to receive log updates
 */
function addSSEClient(res) {
  sseClients.push(res);
  // Remove client when connection closes
  res.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
}

/**
 * Broadcast a log message to all connected SSE clients
 */
function broadcastLog(message) {
  sseClients.forEach(client => {
    try {
      client.write(`data: ${message}\n\n`);
    } catch (e) {
      // Client connection closed, will be removed on close event
    }
  });
}

/**
 * Send a completion signal to all connected SSE clients
 */
function broadcastComplete() {
  sseClients.forEach(client => {
    try {
      client.write(`data: :::IMPORT_COMPLETE:::\n\n`);
      // Close the connection after sending completion signal
      setTimeout(() => client.end(), 100);
    } catch (e) {
      // Client connection closed
    }
  });
  sseClients = [];
}

/**
 * Override console.log to broadcast logs to SSE clients
 */
const originalConsoleLog = console.log;
console.log = function(...args) {
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  
  originalConsoleLog.apply(console, args);
  
  // Only broadcast if import is in progress
  if (importInProgress) {
    broadcastLog(message);
  }
};

// Initialize database tables
async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    console.log('[' + new Date().toISOString() + '] Initializing database tables...');
    
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        log_date DATETIME NOT NULL,
        timestamp_utc DATETIME NOT NULL,
        hostname VARCHAR(255),
        service VARCHAR(100),
        process_id INT,
        message_id VARCHAR(100) UNIQUE,
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_log_date (log_date),
        INDEX idx_service (service),
        INDEX idx_message_id (message_id)
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS emails (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(100) UNIQUE,
        log_date DATETIME NOT NULL,
        sender VARCHAR(255),
        recipient VARCHAR(255),
        size INT,
        relay VARCHAR(255),
        delay DECIMAL(10, 2),
        status VARCHAR(50),
        dsn_code VARCHAR(20),
        response_text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_log_date (log_date),
        INDEX idx_sender (sender),
        INDEX idx_recipient (recipient),
        INDEX idx_status (status)
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS processed_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        log_file VARCHAR(255) NOT NULL,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_file (log_file)
      )
    `);

    console.log('[' + new Date().toISOString() + '] Database tables initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    await connection.release();
  }
}

// ============================================================================
// LOG PARSING - Pre-compiled Regex Patterns
// ============================================================================

// Regex patterns compiled once for performance
const REGEX_PATTERNS = {
  // Format: 2026-02-11T09:26:24... hostname service[pid]: message
  logLine: /^([^\s]+)\s+([^\s]+)\s+([^\s\[]+)\[(\d+)\]:\s+(.*)$/,
  messageId: /^([A-F0-9]+):\s*/,
  email: /(?:<([^>]+)>|([^,\s]+))/,
  from: /from=(?:<([^>]+)>|([^,\s]+))/,
  to: /to=(?:<([^>]+)>|([^,\s]+))/,
  size: /size=(\d+)/,
  relay: /relay=([^\s,]+)/,
  delay: /delay=([\d.]+)/,
  dsn: /dsn=([\d.]+)/,
  status: /status=(\w+)\s+\(([^)]*)\)/
};

/**
 * Parse a single log line
 * @param {string} line - Raw log line
 * @returns {Object|null} Parsed log or null if invalid
 */
function parseLogLine(line) {
  if (!line.trim()) return null;
  
  const match = line.match(REGEX_PATTERNS.logLine);
  if (!match) return null;

  const [, timestamp, hostname, service, processId, content] = match;
  
  try {
    return {
      timestamp,
      logDate: new Date(timestamp),
      hostname,
      service,
      processId: parseInt(processId),
      content
    };
  } catch (error) {
    console.warn(`Failed to parse log line: ${line.substring(0, 80)}...`, error.message);
    return null;
  }
}

/**
 * Extract email data from postfix/qmgr log line
 * @param {string} content - Log content
 * @returns {Object} Email data object
 */
function extractQmgrData(content) {
  const emailData = {};
  
  const fromMatch = content.match(REGEX_PATTERNS.from);
  const sizeMatch = content.match(REGEX_PATTERNS.size);
  
  if (fromMatch) {
    emailData.from = fromMatch[1] || fromMatch[2];
  }
  
  if (sizeMatch) {
    emailData.size = parseInt(sizeMatch[1]);
  }
  
  return emailData;
}

/**
 * Extract email data from postfix/smtp log line
 * @param {string} content - Log content
 * @returns {Object} Email data object
 */
function extractSmtpData(content) {
  const emailData = {};
  
  const toMatch = content.match(REGEX_PATTERNS.to);
  const relayMatch = content.match(REGEX_PATTERNS.relay);
  const delayMatch = content.match(REGEX_PATTERNS.delay);
  const dsnMatch = content.match(REGEX_PATTERNS.dsn);
  const statusMatch = content.match(REGEX_PATTERNS.status);
  
  if (toMatch) {
    emailData.to = toMatch[1] || toMatch[2];
  }
  
  if (relayMatch) {
    emailData.relay = relayMatch[1];
  }
  
  if (delayMatch) {
    emailData.delay = parseFloat(delayMatch[1]);
  }
  
  if (dsnMatch) {
    emailData.dsn = dsnMatch[1];
  }
  
  if (statusMatch) {
    emailData.status = statusMatch[1];
    emailData.response = statusMatch[2];
  }
  
  return emailData;
}

/**
 * Extract message ID from log content
 * @param {string} content - Log content
 * @returns {string|null} Message ID or null
 */
function extractMessageId(content) {
  const match = content.match(REGEX_PATTERNS.messageId);
  return match ? match[1] : null;
}

// ============================================================================
// LOG IMPORT FUNCTION
// ============================================================================

/**
 * Import logs from mail.log file into database
 * Parses new logs, inserts them, and cleans up the log file
 */
async function importLogs() {
  importInProgress = true;
  const connection = await pool.getConnection();
  try {
    const startTime = new Date();
    console.log(`[${startTime.toISOString()}] Starting log import`);

    const LOG_FILE = '/app/logs/mail.log';
    const STATE_FILE = '/app/data/log_state.json';

    // Read previous state
    let state = { lineIndex: 0 };
    try {
      const stateData = await fs.readFile(STATE_FILE, 'utf-8');
      state = JSON.parse(stateData);
    } catch (e) {
      console.log(`[${new Date().toISOString()}] State file not found, starting from beginning`);
    }

    // Read log file
    let fileContent;
    try {
      fileContent = await fs.readFile(LOG_FILE, 'utf-8');
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] Log file not found: ${LOG_FILE}`);
      return;
    }

    // If file is empty, reset state and return
    if (!fileContent.trim()) {
      console.log(`[${new Date().toISOString()}] Log file is empty (${fileContent.length} bytes), resetting state`);
      try {
        const stateDir = path.dirname(STATE_FILE);
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(STATE_FILE, JSON.stringify({
          lineIndex: 0,
          lastProcessed: new Date().toISOString(),
          logsInserted: 0
        }, null, 2));
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Error resetting state:`, e.message);
      }
      return;
    }

    const lines = fileContent.split('\n');
    const newLines = lines.slice(state.lineIndex || 0);

    console.log(`[${new Date().toISOString()}] File has ${lines.length} total lines, state lineIndex: ${state.lineIndex || 0}, new lines to process: ${newLines.length}`);

    if (newLines.length === 0) {
      console.log(`[${new Date().toISOString()}] No new logs to process`);
      return;
    }

    const logsByMessageId = {};
    let insertedCount = 0;
    let parseErrors = 0;

    // Parse and insert logs
    for (const line of newLines) {
      const parsed = parseLogLine(line);
      if (!parsed) {
        if (line.trim()) {
          console.debug(`[${new Date().toISOString()}] Failed to parse line: ${line.substring(0, 100)}`);
        }
        continue;
      }

      try {
        // Insert into logs table
        await connection.execute(
          `INSERT IGNORE INTO logs (log_date, timestamp_utc, hostname, service, process_id, content)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [parsed.logDate, parsed.logDate, parsed.hostname, parsed.service, parsed.processId, parsed.content]
        );
        insertedCount++;

        // Extract message ID for email tracking
        const messageId = extractMessageId(parsed.content);
        if (messageId) {
          if (!logsByMessageId[messageId]) {
            logsByMessageId[messageId] = {
              messageId,
              timestamp: parsed.logDate,
              emailData: {}
            };
          }

          // Extract service-specific email data
          if (parsed.service === 'postfix/qmgr') {
            logsByMessageId[messageId].emailData = {
              ...logsByMessageId[messageId].emailData,
              ...extractQmgrData(parsed.content)
            };
          } else if (parsed.service === 'postfix/smtp') {
            logsByMessageId[messageId].emailData = {
              ...logsByMessageId[messageId].emailData,
              ...extractSmtpData(parsed.content)
            };
          }
        }
      } catch (error) {
        parseErrors++;
        console.error(`[${new Date().toISOString()}] Error processing log line:`, error.message);
      }
    }

    // Insert email records
    let emailInsertedCount = 0;
    for (const [messageId, data] of Object.entries(logsByMessageId)) {
      const emailData = data.emailData;
      if (emailData.to || emailData.from) {
        try {
          await connection.execute(
            `INSERT INTO emails (message_id, log_date, sender, recipient, size, relay, delay, status, dsn_code, response_text)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE 
               sender = COALESCE(VALUES(sender), sender),
               recipient = COALESCE(VALUES(recipient), recipient),
               size = COALESCE(VALUES(size), size),
               relay = COALESCE(VALUES(relay), relay),
               delay = COALESCE(VALUES(delay), delay),
               status = COALESCE(VALUES(status), status),
               dsn_code = COALESCE(VALUES(dsn_code), dsn_code),
               response_text = COALESCE(VALUES(response_text), response_text)`,
            [
              messageId,
              data.timestamp,
              emailData.from || null,
              emailData.to || null,
              emailData.size || null,
              emailData.relay || null,
              emailData.delay || null,
              emailData.status || null,
              emailData.dsn || null,
              emailData.response || null
            ]
          );
          emailInsertedCount++;
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Error inserting email record:`, error.message);
        }
      }
    }

    // Truncate log file after successful import
    try {
      if (insertedCount > 0) {
        await fs.truncate(LOG_FILE, 0);
        console.log(`[${new Date().toISOString()}] Log file truncated`);
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error truncating log file:`, error.message);
    }

    // Update state file - reset lineIndex to 0 if truncated, otherwise set to lines.length
    try {
      const stateDir = path.dirname(STATE_FILE);
      await fs.mkdir(stateDir, { recursive: true });
      const newLineIndex = insertedCount > 0 ? 0 : lines.length;
      await fs.writeFile(STATE_FILE, JSON.stringify({
        lineIndex: newLineIndex,
        lastProcessed: new Date().toISOString(),
        logsInserted: insertedCount,
        emailsInserted: emailInsertedCount,
        parseErrors
      }, null, 2));
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error updating state file:`, error.message);
    }

    const duration = new Date() - startTime;
    console.log(`[${new Date().toISOString()}] Import completed: ${insertedCount} logs, ${emailInsertedCount} emails (${duration}ms, ${parseErrors} errors)`);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Critical error during import:`, error);
  } finally {
    await connection.release();
    importInProgress = false;
    // Send completion signal to all SSE clients
    broadcastComplete();
  }
}

// ============================================================================
// SCHEDULED JOBS
// ============================================================================

// Cron job - every hour
cron.schedule('0 * * * *', () => {
  console.log(`[${new Date().toISOString()}] Scheduled import job triggered (every hour)`);
  importLogs();
});

// ============================================================================
// REST API ENDPOINTS
// ============================================================================

/**
 * GET /api/logs
 * Retrieve all logs with optional filters and pagination
 * Query parameters:
 *   - page: Current page (default: 1)
 *   - limit: Records per page (default: 100)
 *   - dateFrom: Filter by start date (ISO format)
 *   - dateTo: Filter by end date (ISO format)
 *   - search: Search in log content
 */
app.get('/api/logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const offset = (page - 1) * limit;
    
    const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
    const dateTo = req.query.dateTo ? new Date(req.query.dateTo) : null;
    const searchText = req.query.search || '';

    // Build dynamic query based on filters
    let query = 'SELECT * FROM logs WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as total FROM logs WHERE 1=1';
    const params = [];
    const countParams = [];

    if (dateFrom) {
      query += ' AND log_date >= ?';
      countQuery += ' AND log_date >= ?';
      params.push(dateFrom);
      countParams.push(dateFrom);
    }

    if (dateTo) {
      query += ' AND log_date <= ?';
      countQuery += ' AND log_date <= ?';
      params.push(dateTo);
      countParams.push(dateTo);
    }

    if (searchText) {
      query += ' AND content LIKE ?';
      countQuery += ' AND content LIKE ?';
      const searchParam = `%${searchText}%`;
      params.push(searchParam);
      countParams.push(searchParam);
    }

    query += ' ORDER BY log_date DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const connection = await pool.getConnection();
    const [logs] = await connection.query(query, params);
    const [[{ total }]] = await connection.query(countQuery, countParams);
    await connection.release();

    res.json({
      data: logs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching logs:`, error.message);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// Get processed emails with filters
app.get('/api/emails', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const offset = (page - 1) * limit;

    const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
    const dateTo = req.query.dateTo ? new Date(req.query.dateTo) : null;
    const sender = req.query.sender || '';
    const recipient = req.query.recipient || '';
    const searchText = req.query.search || '';

    // Build dynamic query based on filters
    let query = 'SELECT * FROM emails WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as total FROM emails WHERE 1=1';
    const params = [];
    const countParams = [];

    if (dateFrom) {
      query += ' AND log_date >= ?';
      countQuery += ' AND log_date >= ?';
      params.push(dateFrom);
      countParams.push(dateFrom);
    }

    if (dateTo) {
      query += ' AND log_date <= ?';
      countQuery += ' AND log_date <= ?';
      params.push(dateTo);
      countParams.push(dateTo);
    }

    if (sender) {
      query += ' AND sender LIKE ?';
      countQuery += ' AND sender LIKE ?';
      const senderParam = `%${sender}%`;
      params.push(senderParam);
      countParams.push(senderParam);
    }

    if (recipient) {
      query += ' AND recipient LIKE ?';
      countQuery += ' AND recipient LIKE ?';
      const recipientParam = `%${recipient}%`;
      params.push(recipientParam);
      countParams.push(recipientParam);
    }

    if (searchText) {
      query += ' AND (sender LIKE ? OR recipient LIKE ? OR response_text LIKE ?)';
      countQuery += ' AND (sender LIKE ? OR recipient LIKE ? OR response_text LIKE ?)';
      const searchParam = `%${searchText}%`;
      params.push(searchParam, searchParam, searchParam);
      countParams.push(searchParam, searchParam, searchParam);
    }

    query += ' ORDER BY log_date DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const connection = await pool.getConnection();
    const [emails] = await connection.query(query, params);
    const [[{ total }]] = await connection.query(countQuery, countParams);
    await connection.release();

    res.json({
      data: emails,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching emails:`, error.message);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

/**
 * GET /api/stats
 * Get aggregated statistics about logs and emails
 * Query parameters:
 *   - today: If "true", filter by current date only
 */
app.get('/api/stats', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const today = req.query.today === 'true';

    // Build date filter if today is requested
    let dateFilter = '';
    let dateParams = [];
    if (today) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      
      dateFilter = ' WHERE log_date >= ? AND log_date <= ?';
      dateParams = [startOfDay, endOfDay];
    }

    const [[{ totalLogs }]] = await connection.query(
      `SELECT COUNT(*) as totalLogs FROM logs${dateFilter}`,
      dateParams
    );

    const [[{ totalEmails }]] = await connection.query(
      `SELECT COUNT(*) as totalEmails FROM emails${dateFilter}`,
      dateParams
    );

    // For sent emails, need to combine WHERE conditions
    let sentFilter = ' WHERE status = \'sent\'';
    let sentParams = [];
    if (today) {
      sentFilter += ' AND log_date >= ? AND log_date <= ?';
      sentParams = dateParams;
    }
    const [[{ sentEmails }]] = await connection.query(
      `SELECT COUNT(*) as sentEmails FROM emails${sentFilter}`,
      sentParams
    );

    // For failed emails, need to combine WHERE conditions
    let failedFilter = ' WHERE status != \'sent\' AND status IS NOT NULL';
    let failedParams = [];
    if (today) {
      failedFilter += ' AND log_date >= ? AND log_date <= ?';
      failedParams = dateParams;
    }
    const [[{ failedEmails }]] = await connection.query(
      `SELECT COUNT(*) as failedEmails FROM emails${failedFilter}`,
      failedParams
    );

    await connection.release();

    res.json({
      totalLogs,
      totalEmails,
      sentEmails,
      failedEmails
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching stats:`, error.message);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /api/import-logs/stream
 * Server-Sent Events stream for real-time log updates during import
 */
app.get('/api/import-logs/stream', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Add client to list
  addSSEClient(res);

  // Send initial message
  res.write('data: Connesso al log stream\n\n');
});

/**
 * POST /api/import-logs
 * Manually trigger log import (runs asynchronously)
 */
app.post('/api/import-logs', async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] Manual import requested`);
    await importLogs();
    res.json({ message: 'Import completed successfully' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error during manual import:`, error.message);
    res.status(500).json({ error: 'Failed to import logs' });
  }
});

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================================
// SERVER STARTUP & SHUTDOWN
// ============================================================================

// ============================================================================
// SERVER STARTUP & SHUTDOWN
// ============================================================================

/**
 * Start the Express server and initialize the application
 * 1. Initialize database tables
 * 2. Run initial log import
 * 3. Start listening for requests
 */
app.listen(port, () => {
  console.log(`[${new Date().toISOString()}] Backend server running on port ${port}`);
  
  // Wait 5 seconds for database to be ready, then initialize
  setTimeout(async () => {
    try {
      console.log(`[${new Date().toISOString()}] Initializing application...`);
      await initializeDatabase();
      console.log(`[${new Date().toISOString()}] Running initial import`);
      await importLogs();
      console.log(`[${new Date().toISOString()}] Application initialized successfully`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Critical error during initialization:`, error.message);
      console.error(error.stack);
    }
  }, 5000);
});

/**
 * GET /api/stats/chart
 * Get email statistics for charting
 * Query parameters:
 *   - period: 'day', 'week', 'month', or 'year' (default: 'day')
 *   - date: Reference date in ISO format (default: today)
 */
app.get('/api/stats/chart', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const period = req.query.period || 'day';
    const referenceDate = req.query.date ? new Date(req.query.date) : new Date();
    
    let data = [];
    let labels = [];

    if (period === 'day') {
      // Hourly data for the day
      const startOfDay = new Date(referenceDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(referenceDate);
      endOfDay.setHours(23, 59, 59, 999);

      const [rows] = await connection.query(
        `SELECT HOUR(log_date) as hour, COUNT(*) as count 
         FROM emails 
         WHERE log_date >= ? AND log_date <= ? AND status = 'sent'
         GROUP BY HOUR(log_date) 
         ORDER BY hour`,
        [startOfDay, endOfDay]
      );

      // Fill in all 24 hours even if no data
      for (let hour = 0; hour < 24; hour++) {
        const row = rows.find(r => r.hour === hour);
        labels.push(`${hour.toString().padStart(2, '0')}:00`);
        data.push(row ? row.count : 0);
      }
    } else if (period === 'week') {
      // Daily data for the week (7 days before reference date)
      const startOfWeek = new Date(referenceDate);
      startOfWeek.setDate(startOfWeek.getDate() - 6);
      startOfWeek.setHours(0, 0, 0, 0);
      const endOfWeek = new Date(referenceDate);
      endOfWeek.setHours(23, 59, 59, 999);

      const [rows] = await connection.query(
        `SELECT DATE(log_date) as day, COUNT(*) as count 
         FROM emails 
         WHERE log_date >= ? AND log_date <= ? AND status = 'sent'
         GROUP BY DATE(log_date) 
         ORDER BY day`,
        [startOfWeek, endOfWeek]
      );

      // Fill all 7 days
      for (let i = 6; i >= 0; i--) {
        const date = new Date(referenceDate);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        const row = rows.find(r => r.day === dateStr);
        labels.push(new Date(date).toLocaleDateString('it-IT', { weekday: 'short', month: 'short', day: 'numeric' }));
        data.push(row ? row.count : 0);
      }
    } else if (period === 'month') {
      // Daily data for the month
      const startOfMonth = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
      startOfMonth.setHours(0, 0, 0, 0);
      const endOfMonth = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0);
      endOfMonth.setHours(23, 59, 59, 999);

      const [rows] = await connection.query(
        `SELECT DATE(log_date) as day, COUNT(*) as count 
         FROM emails 
         WHERE log_date >= ? AND log_date <= ? AND status = 'sent'
         GROUP BY DATE(log_date) 
         ORDER BY day`,
        [startOfMonth, endOfMonth]
      );

      // Fill all days of the month
      const daysInMonth = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0).getDate();
      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), day);
        const dateStr = date.toISOString().split('T')[0];
        const row = rows.find(r => r.day === dateStr);
        labels.push(day.toString());
        data.push(row ? row.count : 0);
      }
    } else if (period === 'year') {
      // Monthly data for the year
      const startOfYear = new Date(referenceDate.getFullYear(), 0, 1);
      startOfYear.setHours(0, 0, 0, 0);
      const endOfYear = new Date(referenceDate.getFullYear(), 11, 31);
      endOfYear.setHours(23, 59, 59, 999);

      const [rows] = await connection.query(
        `SELECT MONTH(log_date) as month, COUNT(*) as count 
         FROM emails 
         WHERE log_date >= ? AND log_date <= ? AND status = 'sent'
         GROUP BY MONTH(log_date) 
         ORDER BY month`,
        [startOfYear, endOfYear]
      );

      // Fill all 12 months
      const months = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
      for (let month = 1; month <= 12; month++) {
        const row = rows.find(r => r.month === month);
        labels.push(months[month - 1]);
        data.push(row ? row.count : 0);
      }
    }

    await connection.release();

    res.json({
      labels,
      data,
      period,
      referenceDate
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching chart data:`, error.message);
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
});

/**
 * Graceful shutdown
 * Close database connections and exit cleanly when receiving SIGTERM signal
 */
process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] SIGTERM signal received: closing gracefully`);
  pool.end((err) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Error closing database pool:`, err.message);
      process.exit(1);
    } else {
      console.log(`[${new Date().toISOString()}] Database connections closed`);
      process.exit(0);
    }
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error(`[${new Date().toISOString()}] Uncaught Exception:`, error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] Unhandled Rejection at:`, promise, 'reason:', reason);
});
