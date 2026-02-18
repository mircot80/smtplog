#!/usr/bin/env node

/**
 * SMTP Log Parser and Database Importer
 * Parses Postfix/OpenDKIM logs and imports them into MariaDB
 * Runs every hour to import new logs
 */

const mysql = require('mysql2/promise');
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

const LOG_FILE = process.env.LOG_FILE || '/app/logs/mail.log';
const STATE_FILE = '/app/data/log_state.json';
const QUEUE_DIR = process.env.QUEUE_DIR || '/var/spool/postfix';

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'smtplog_user',
  password: process.env.DB_PASSWORD || 'smtplog_password',
  database: process.env.DB_NAME || 'smtplog',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
};

// Create pool
const pool = mysql.createPool(dbConfig);

/**
 * Parse Postfix log line
 * Format: 2026-02-11T09:26:24.771360+01:00 hostname service[pid]: message
 */
function parseLogLine(line) {
  const regex = /^([^\s]+)\s+([^\s]+)\s+([^\s\[]+)\[(\d+)\]:\s+(.*)$/;
  const match = line.match(regex);
  
  if (!match) return null;

  const [, timestamp, hostname, service, processId, content] = match;

  return {
    timestamp,
    hostname,
    service,
    processId: parseInt(processId),
    content
  };
}

/**
 * Parse queue data from postqueue command output
 */
function parsePostqueueOutput(output) {
  const queueData = {};
  
  if (!output || output.trim() === 'Mail queue is empty' || output.trim() === 'unavailable') {
    return queueData;
  }
  
  const lines = output.trim().split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('-') || line.startsWith('Mail')) continue;
    
    // Parse postqueue line: ID SIZE DATE FROM TO STATUS...
    const parts = line.split(/\s+/);
    if (parts.length >= 5 && /^[A-F0-9]+$/.test(parts[0])) {
      const id = parts[0];
      const size = parts[1];
      
      // Extract sender and recipient (they have @)
      let from = '';
      let to = '';
      let status = '';
      
      for (let j = 5; j < parts.length; j++) {
        if (parts[j].includes('@')) {
          if (!from) from = parts[j];
          else if (!to) to = parts[j];
        } else {
          status += ' ' + parts[j];
        }
      }
      
      if (id && size && from) {
        queueData[id] = {
          id,
          size: parseInt(size),
          from,
          to: to || 'unknown',
          status: status.trim()
        };
      }
    }
  }
  
  return queueData;
}

/**
 * Extract email information from log content
 */
function extractEmailInfo(service, content) {
  const emailInfo = {};

  if (service === 'postfix/qmgr') {
    const fromMatch = content.match(/from=<([^>]*)>/);
    const sizeMatch = content.match(/size=(\d+)/);
    
    if (fromMatch) emailInfo.from = fromMatch[1];
    if (sizeMatch) emailInfo.size = parseInt(sizeMatch[1]);
  } else if (service === 'postfix/smtp') {
    const toMatch = content.match(/to=<([^>]*)>/);
    const relayMatch = content.match(/relay=([^\s,]+)/);
    const delayMatch = content.match(/delay=([\d.]+)/);
    const dsnMatch = content.match(/dsn=([\d.]+)/);
    const statusMatch = content.match(/status=(\w+)\s+\(([^)]*)\)/);

    if (toMatch) emailInfo.to = toMatch[1];
    if (relayMatch) emailInfo.relay = relayMatch[1];
    if (delayMatch) emailInfo.delay = parseFloat(delayMatch[1]);
    if (dsnMatch) emailInfo.dsn = dsnMatch[1];
    if (statusMatch) {
      emailInfo.status = statusMatch[1];
      emailInfo.response = statusMatch[2];
    }
  }

  return emailInfo;
}

/**
 * Archive old bounced/held emails
 * Moves emails with status 'bounced' or 'held' older than 30 days to 'archived'
 */
async function archiveOldEmails() {
  const connection = await pool.getConnection();

  try {
    console.log(`[${new Date().toISOString()}] Archiving old emails`);

    const result = await connection.execute(
      `UPDATE emails 
       SET status = 'archived', updated_at = NOW()
       WHERE status IN ('bounced', 'held') 
       AND updated_at < NOW() - INTERVAL 30 DAY`
    );

    if (result[0].affectedRows > 0) {
      console.log(`[${new Date().toISOString()}] Archived ${result[0].affectedRows} old emails`);
    }

  } catch (error) {
    console.error(`Error archiving emails: ${error.message}`);
  } finally {
    await connection.release();
  }
}

/**
 * Sync pending emails from Postfix queue using postqueue -p
 */
async function syncQueueEmails() {
  const connection = await pool.getConnection();

  try {
    console.log(`[${new Date().toISOString()}] Syncing queue emails from postfix`);

    let queueData = {};

    try {
      // Try to execute postqueue -p
      const queueOutput = execSync('postqueue -p 2>/dev/null || echo "unavailable"', { 
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore']
      });

      queueData = parsePostqueueOutput(queueOutput);
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] Could not read queue with postqueue: ${e.message}`);
      // Continue anyway - queue sync is optional
      return;
    }

    // Process each queue entry
    for (const [messageId, queueEntry] of Object.entries(queueData)) {
      try {
        // Check if already in database
        const [existing] = await connection.execute(
          'SELECT message_id FROM emails WHERE message_id = ?',
          [messageId]
        );

        const now = new Date();

        if (existing.length > 0) {
          // Already in DB, update status if needed
          await connection.execute(
            `UPDATE emails SET status = ?, updated_at = NOW() 
             WHERE message_id = ?`,
            [queueEntry.status, messageId]
          );
        } else {
          // New email in queue
          await connection.execute(
            `INSERT INTO emails (message_id, log_date, sender, recipient, size, status)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE 
               status = VALUES(status),
               updated_at = NOW()`,
            [
              messageId,
              now,
              queueEntry.from || null,
              queueEntry.to || null,
              queueEntry.size || null,
              queueEntry.status
            ]
          );
        }
      } catch (e) {
        console.error(`Error processing queue entry ${messageId}: ${e.message}`);
      }
    }

    console.log(`[${new Date().toISOString()}] Queue sync completed (${Object.keys(queueData).length} entries)`);

  } catch (error) {
    console.error(`Error syncing queue emails: ${error.message}`);
  } finally {
    await connection.release();
  }
}

/**
 * Process log file and insert into database
 */
async function processLogs() {
  const connection = await pool.getConnection();

  try {
    console.log(`[${new Date().toISOString()}] Starting log import from ${LOG_FILE}`);

    // Get current state
    let state = { position: 0 };
    try {
      const stateData = await fs.readFile(STATE_FILE, 'utf-8');
      state = JSON.parse(stateData);
    } catch (e) {
      // File doesn't exist, start from beginning
    }

    // Read file starting from last position
    const fileContent = await fs.readFile(LOG_FILE, 'utf-8');
    const lines = fileContent.split('\n');
    const newLines = lines.slice(state.lineIndex || 0);

    if (newLines.length === 0) {
      console.log('No new logs to process');
      return;
    }

    const logsByMessageId = {};
    const logs = [];

    // Parse all lines
    for (const line of newLines) {
      if (!line.trim()) continue;

      const parsed = parseLogLine(line);
      if (!parsed) continue;

      logs.push(parsed);

      // Extract message ID from content
      const msgIdMatch = parsed.content.match(/^([A-F0-9]+):\s*/);
      if (msgIdMatch) {
        const messageId = msgIdMatch[1];
        if (!logsByMessageId[messageId]) {
          logsByMessageId[messageId] = {
            messageId,
            logs: [],
            emailData: {}
          };
        }
        logsByMessageId[messageId].logs.push(parsed);

        // Extract email info
        const emailInfo = extractEmailInfo(parsed.service, parsed.content);
        logsByMessageId[messageId].emailData = {
          ...logsByMessageId[messageId].emailData,
          ...emailInfo
        };
      }
    }

    // Insert logs into database
    for (const log of logs) {
      const logDate = new Date(log.timestamp);
      
      try {
        await connection.execute(
          `INSERT INTO logs (log_date, timestamp_utc, hostname, service, process_id, content)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE created_at = NOW()`,
          [logDate, logDate, log.hostname, log.service, log.processId, log.content]
        );
      } catch (e) {
        console.error(`Error inserting log: ${e.message}`);
      }
    }

    // Insert/update email records
    for (const [messageId, data] of Object.entries(logsByMessageId)) {
      if (data.emailData.to || data.emailData.from) {
        const emailData = data.emailData;
        const logDate = data.logs[0] ? new Date(data.logs[0].timestamp) : new Date();

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
              logDate,
              emailData.from || null,
              emailData.to || null,
              emailData.size || null,
              emailData.relay || null,
              emailData.delay || null,
       Archive old emails
    await archiveOldEmails();

    //        emailData.status || null,
              emailData.dsn || null,
              emailData.response || null
            ]
          );
        } catch (e) {
          console.error(`Error inserting email record: ${e.message}`);
        }
      }
    }

    // Update state and clear log file if needed
    const newState = {
      lineIndex: lines.length,
      lastProcessed: new Date().toISOString(),
      entriesProcessed: newLines.length
    };

    // Create directory if needed
    const stateDir = path.dirname(STATE_FILE);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(newState, null, 2));

    console.log(`[${new Date().toISOString()}] Imported ${newLines.length} log entries`);

    // Sync queue emails after importing logs
    await syncQueueEmails();

    // Clear processed logs if requested
    if (process.env.CLEAR_LOGS === 'true') {
      await fs.writeFile(LOG_FILE, '');
      console.log('Cleared mail.log file');
    }

  } catch (error) {
    console.error(`Error processing logs: ${error.message}`, error);
    process.exit(1);
  } finally {
    await connection.release();
  }
}

/**
 * Main scheduler
 */
async function main() {
  console.log('SMTP Log Importer started');

  // Run immediately
  await processLogs();

  // Schedule hourly
  const runInterval = setInterval(async () => {
    try {
      await processLogs();
    } catch (error) {
      console.error('Scheduled import failed:', error);
    }
  }, 60 * 60 * 1000); // Every hour

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    clearInterval(runInterval);
    pool.end(() => {
      console.log('Pool closed');
      process.exit(0);
    });
  });
}

main().catch(console.error);
