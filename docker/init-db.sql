-- Schema del database SMTPLOG

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
);

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
);

CREATE TABLE IF NOT EXISTS processed_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  log_file VARCHAR(255) NOT NULL,
  last_position BIGINT,
  processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_file (log_file)
);
