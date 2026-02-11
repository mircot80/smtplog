const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');

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

// Import logs function (from log-importer.js logic)
async function importLogs() {
  const connection = await pool.getConnection();
  try {
    console.log(`[${new Date().toISOString()}] Starting log import`);

    const LOG_FILE = '/app/logs/mail.log';
    const STATE_FILE = '/app/data/log_state.json';

    let state = { lineIndex: 0 };
    try {
      const stateData = await fs.readFile(STATE_FILE, 'utf-8');
      state = JSON.parse(stateData);
    } catch (e) {
      // File doesn't exist
    }

    const fileContent = await fs.readFile(LOG_FILE, 'utf-8');
    const lines = fileContent.split('\n');
    const newLines = lines.slice(state.lineIndex || 0);

    if (newLines.length === 0) {
      console.log('No new logs to process');
      return;
    }

    const logsByMessageId = {};
    let insertedCount = 0;

    // Parse and insert logs
    for (const line of newLines) {
      if (!line.trim()) continue;

      const regex = /^([^\s]+)\s+([^\s]+)\s+([^\s\[]+)\[(\d+)\]:\s+(.*)$/;
      const match = line.match(regex);
      
      if (!match) continue;

      const [, timestamp, hostname, service, processId, content] = match;
      const logDate = new Date(timestamp);

      await connection.execute(
        `INSERT IGNORE INTO logs (log_date, timestamp_utc, hostname, service, process_id, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [logDate, logDate, hostname, service, parseInt(processId), content]
      );
      insertedCount++;

      // Extract message ID
      const msgIdMatch = content.match(/^([A-F0-9]+):\s*/);
      if (msgIdMatch) {
        const messageId = msgIdMatch[1];
        if (!logsByMessageId[messageId]) {
          logsByMessageId[messageId] = {
            messageId,
            timestamp: logDate,
            emailData: {}
          };
        }

        // Extract email info
        if (service === 'postfix/qmgr') {
          const fromMatch = content.match(/from=(?:<([^>]+)>|([^,\s]+))/);
          const sizeMatch = content.match(/size=(\d+)/);
          if (fromMatch) logsByMessageId[messageId].emailData.from = fromMatch[1] || fromMatch[2];
          if (sizeMatch) logsByMessageId[messageId].emailData.size = parseInt(sizeMatch[1]);
        } else if (service === 'postfix/smtp') {
          const toMatch = content.match(/to=(?:<([^>]+)>|([^,\s]+))/);
          const relayMatch = content.match(/relay=([^\s,]+)/);
          const delayMatch = content.match(/delay=([\d.]+)/);
          const dsnMatch = content.match(/dsn=([\d.]+)/);
          const statusMatch = content.match(/status=(\w+)\s+\(([^)]*)\)/);

          if (toMatch) logsByMessageId[messageId].emailData.to = toMatch[1] || toMatch[2];
          if (relayMatch) logsByMessageId[messageId].emailData.relay = relayMatch[1];
          if (delayMatch) logsByMessageId[messageId].emailData.delay = parseFloat(delayMatch[1]);
          if (dsnMatch) logsByMessageId[messageId].emailData.dsn = dsnMatch[1];
          if (statusMatch) {
            logsByMessageId[messageId].emailData.status = statusMatch[1];
            logsByMessageId[messageId].emailData.response = statusMatch[2];
          }
        }
      }
    }

    // Insert email records
    for (const [messageId, data] of Object.entries(logsByMessageId)) {
      const emailData = data.emailData;
      if (emailData.to || emailData.from) {
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
      }
    }

    // Update state
    const stateDir = path.dirname(STATE_FILE);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify({
      lineIndex: lines.length,
      lastProcessed: new Date().toISOString(),
      entriesProcessed: insertedCount
    }, null, 2));

    // Truncate log file after successful import
    if (insertedCount > 0) {
      await fs.truncate(LOG_FILE, 0);
      console.log(`[${new Date().toISOString()}] Truncated log file`);
    }

    console.log(`[${new Date().toISOString()}] Imported ${insertedCount} log entries`);

  } catch (error) {
    console.error('Error importing logs:', error);
  } finally {
    await connection.release();
  }
}

// Cron job - every hour
cron.schedule('0 * * * *', () => {
  console.log('Running scheduled import');
  importLogs();
});

// API Routes

// Get all logs with filters
app.get('/api/logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const offset = (page - 1) * limit;
    
    const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
    const dateTo = req.query.dateTo ? new Date(req.query.dateTo) : null;
    const searchText = req.query.search || '';

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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
  }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [[{ totalLogs }]] = await connection.query(
      'SELECT COUNT(*) as totalLogs FROM logs'
    );

    const [[{ totalEmails }]] = await connection.query(
      'SELECT COUNT(*) as totalEmails FROM emails'
    );

    const [[{ sentEmails }]] = await connection.query(
      "SELECT COUNT(*) as sentEmails FROM emails WHERE status = 'sent'"
    );

    const [[{ failedEmails }]] = await connection.query(
      "SELECT COUNT(*) as failedEmails FROM emails WHERE status != 'sent' AND status IS NOT NULL"
    );

    await connection.release();

    res.json({
      totalLogs,
      totalEmails,
      sentEmails,
      failedEmails
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Force import logs
app.post('/api/import-logs', async (req, res) => {
  try {
    console.log('[' + new Date().toISOString() + '] Manual import requested');
    await importLogs();
    res.json({ message: 'Import started successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server
app.listen(port, () => {
  console.log(`Backend server running on port ${port}`);
  
  // Initialize database and then run initial import
  setTimeout(async () => {
    try {
      await initializeDatabase();
      console.log('Running initial import');
      await importLogs();
    } catch (error) {
      console.error('Error during initialization:', error);
    }
  }, 5000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing...');
  pool.end(() => {
    process.exit(0);
  });
});
