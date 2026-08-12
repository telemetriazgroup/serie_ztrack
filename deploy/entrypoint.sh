#!/bin/sh
set -e

# HTTPS opcional para celular / LAN (Web Serial exige contexto seguro)
if [ "${ENABLE_HTTPS:-0}" = "1" ]; then
  CERT_DIR="${CERT_DIR:-/certs}"
  mkdir -p "$CERT_DIR"
  if [ ! -f "$CERT_DIR/cert.pem" ] || [ ! -f "$CERT_DIR/key.pem" ]; then
    echo "Generando certificado autofirmado en $CERT_DIR ..."
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$CERT_DIR/key.pem" \
      -out "$CERT_DIR/cert.pem" \
      -days 825 \
      -subj "/CN=ztrack-serial/O=ZTrack/C=PE"
  fi
  exec uvicorn app.main:app --host 0.0.0.0 --port 9490 \
    --ssl-certfile "$CERT_DIR/cert.pem" \
    --ssl-keyfile "$CERT_DIR/key.pem"
fi

exec uvicorn app.main:app --host 0.0.0.0 --port 9490
