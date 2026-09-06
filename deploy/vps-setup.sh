#!/usr/bin/env bash
# Setup / update del Tenis Bot en un VPS Ubuntu/Debian (como root).
#
# Idempotente: la primera vez instala todo; las siguientes hace `git pull`,
# reinstala deps y reinicia el server. Corré:
#
#   /opt/tenis-bot/deploy/vps-setup.sh
#
# El repo debe estar clonado en /opt/tenis-bot (ver DEPLOY.md, "Primer setup").
set -euo pipefail

REPO_DIR="/opt/tenis-bot"
DATA_DIR="/var/lib/tenis-bot"
ENV_FILE="/etc/tenis-bot.env"
# Dominio propio: el registro A de botenis.sdl.ar apunta a la IP del VPS.
# Override con TENISBOT_HOST=... para otro host.
HOST="${TENISBOT_HOST:-botenis.sdl.ar}"

[ -d "$REPO_DIR/.git" ] || { echo "ERROR: no encuentro el repo en $REPO_DIR. Cloná primero (ver DEPLOY.md)." >&2; exit 1; }

# --- 1. Node 20 (si falta) --------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "==> Instalando Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "==> Node $(node --version)"

# --- 2. Caddy (si falta) ----------------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Instalando Caddy..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# --- 3. Traer código al día + deps ------------------------------------------
echo "==> git pull..."
git -C "$REPO_DIR" pull --ff-only
echo "==> npm ci (solo prod)..."
( cd "$REPO_DIR" && npm ci --omit=dev )

# --- 4. Data dir fuera del repo (config, vapid, logs) -----------------------
echo "==> Preparando data dir en ${DATA_DIR}..."
mkdir -p "$DATA_DIR"

# --- 5. Env file (credenciales CAEP) ----------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  echo "==> Creando placeholder ${ENV_FILE} — EDITALO con las credenciales reales."
  cat > "$ENV_FILE" <<'EOF'
CAEP_EMAIL=
CAEP_PASSWORD=
EOF
  chmod 600 "$ENV_FILE"
fi

# --- 6. Servicio systemd ----------------------------------------------------
echo "==> Instalando servicio systemd..."
cp "$REPO_DIR/deploy/vps/tenis-bot.service" /etc/systemd/system/tenis-bot.service
systemctl daemon-reload
systemctl enable tenis-bot
systemctl restart tenis-bot

# --- 7. Caddy: reverse proxy con TLS automático -----------------------------
# Gestiona SOLO el bloque de este host (append idempotente), sin pisar otros
# sitios que convivan en el mismo Caddyfile (aesir, etc.).
echo "==> Configurando Caddy (TLS automático de Let's Encrypt)..."
CADDYFILE=/etc/caddy/Caddyfile
touch "$CADDYFILE"
if ! grep -q "^${HOST} {" "$CADDYFILE" 2>/dev/null; then
  printf '\n%s {\n\treverse_proxy localhost:3000\n}\n' "$HOST" >> "$CADDYFILE"
fi
caddy validate --config "$CADDYFILE" >/dev/null 2>&1 || {
  echo "ERROR: Caddyfile inválido tras editar. Revisá $CADDYFILE" >&2; exit 1;
}
systemctl reload caddy || systemctl restart caddy

# --- 8. Firewall ------------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp   >/dev/null 2>&1 || true
  ufw allow 443/tcp  >/dev/null 2>&1 || true
fi

echo ""
echo "======================================================================"
echo " Listo. App: https://${HOST}"
echo " Estado:  systemctl status tenis-bot --no-pager"
echo " Logs:    journalctl -u tenis-bot -f"
echo "======================================================================"
