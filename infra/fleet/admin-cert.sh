#!/usr/bin/env bash
# Клиентский сертификат пульта (R211): без него TLS к имени пульта не устанавливается (edge, require_and_verify).
#
#   sudo bash infra/fleet/admin-cert.sh <имя>        # новый сертификат, например owner-laptop
#
# Центр (ключ и сертификат) — один раз, в .local/admin-ca (0700, вне git). Его публичная часть — в
# infra/generated/tls/admin-ca.crt, её читает edge. Сертификат человека — .p12 с паролем (Windows, macOS, Chrome,
# Firefox ставят его двойным щелчком), кладётся в /opt/assets; пароль печатается один раз.
set -euo pipefail
NAME=${1:?нужно имя сертификата, например owner-laptop}
[[ $NAME =~ ^[a-z0-9-]{3,40}$ ]] || { echo "имя — латиница, цифры и дефис" >&2; exit 2; }
ROOT=${CORD_DIR:-/opt/ModernStreamingSystem}
CA=$ROOT/.local/admin-ca
OUT=${CORD_CERT_OUT:-/opt/assets}
umask 077
install -d -m 700 "$CA" "$CA/issued"
if [[ ! -s $CA/ca.key ]]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$CA/ca.key"
  openssl req -x509 -new -key "$CA/ca.key" -sha256 -days 3650 -subj "/CN=Cord admin CA/O=Cord" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out "$CA/ca.crt"
fi
install -d "$ROOT/infra/generated/tls"
install -m 644 "$CA/ca.crt" "$ROOT/infra/generated/tls/admin-ca.crt"
D=$CA/issued/$NAME
install -d -m 700 "$D"
openssl ecparam -name prime256v1 -genkey -noout -out "$D/client.key"
openssl req -new -key "$D/client.key" -subj "/CN=$NAME/O=Cord admin" -out "$D/client.csr"
cat > "$D/ext.cnf" <<CNF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
CNF
openssl x509 -req -in "$D/client.csr" -CA "$CA/ca.crt" -CAkey "$CA/ca.key" -CAcreateserial -days 730 -sha256 \
  -extfile "$D/ext.cnf" -out "$D/client.crt" 2>/dev/null
PASS=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
openssl pkcs12 -export -inkey "$D/client.key" -in "$D/client.crt" -certfile "$CA/ca.crt" -name "Cord admin · $NAME" \
  -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 -passout "pass:$PASS" -out "$D/client.p12"
install -d "$OUT"
install -m 600 "$D/client.p12" "$OUT/cord-admin-$NAME.p12"
echo "Сертификат: $OUT/cord-admin-$NAME.p12"
echo "Пароль .p12: $PASS"
echo "Срок: $(openssl x509 -in "$D/client.crt" -noout -enddate | cut -d= -f2)"
