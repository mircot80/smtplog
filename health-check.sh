#!/bin/bash

# Script per verificare lo stato del sistema SMTP Log Viewer

echo "=== SMTP Log Viewer - Health Check ==="
echo ""

# Controllare Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker non è installato"
    exit 1
fi
echo "✓ Docker è installato"

# Controllare i container
echo ""
echo "Stato dei container:"
docker-compose ps 2>/dev/null || echo "❌ docker-compose non trovato nella directory corrente"

# Controllare la connessione al database
echo ""
echo "Test connessione database:"
docker exec smtplog-mariadb mysql -u smtplog_user -psmtplog_password smtplog -e "SELECT COUNT(*) as log_count FROM logs;" 2>/dev/null || echo "❌ Impossibile connettersi al database"

# Controllare l'API
echo ""
echo "Test API backend:"
curl -s http://localhost:3000/api/health | grep -q "ok" && echo "✓ Backend è online" || echo "❌ Backend non risponde"

# Controllare il frontend
echo ""
echo "Test frontend:"
curl -s http://localhost:8080 | grep -q "SMTP Log Viewer" && echo "✓ Frontend è online" || echo "❌ Frontend non risponde"

echo ""
echo "=== Health Check Completato ==="
