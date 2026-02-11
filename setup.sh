#!/bin/bash

# Configurazione del container Postfix e MariaDB
# Questo script deve essere eseguito una volta per inizializzare il sistema

echo "=== Setup SMTP Log System ==="

# Creare le directory necessarie
mkdir -p /opt/postfix/opendkim/keys/casarin.it
mkdir -p /opt/postfix/postfix-logs
mkdir -p /opt/postfix/db-init

# Copiare il file di init del database
cp docker/init-db.sql /opt/postfix/db-init/

echo "✓ Directory create"
echo ""

# Permessi
chmod 755 /opt/postfix/postfix-logs
chmod 755 /opt/postfix/db-init

echo "✓ Permessi impostati"
echo ""

echo "=== Setup completato ==="
echo ""
echo "Per avviare i servizi:"
echo "  cd docker/"
echo "  docker-compose up -d"
echo ""
echo "Per visualizzare l'interfaccia web:"
echo "  http://localhost:8080"
echo ""
echo "Per visualizzare i log dei container:"
echo "  docker-compose logs -f"
