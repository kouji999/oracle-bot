#!/usr/bin/env bash
# Oracle Cloud VM setup — jalankan sekali di VPS Ubuntu (user dengan sudo).
# Asumsi: VM ARM A1 (free tier), Ubuntu 22.04/24.04, port 22 terbuka.

set -euo pipefail

APP_DIR=/opt/oracle-bot

echo "== 1. Node.js 24 (NodeSource) =="
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== 2. User & direktori =="
id oracle &>/dev/null || sudo useradd -r -m -s /usr/sbin/nologin oracle
sudo mkdir -p $APP_DIR
sudo chown oracle:oracle $APP_DIR

echo "== 3. Copy project (dari laptop, di luar script ini):"
echo "   rsync -av --exclude node_modules --exclude data --exclude .git ./ oracle@VM_IP:/opt/oracle-bot/"
echo "   atau: git clone + copy .env manual"

echo "== 4. Install & build =="
cd $APP_DIR
sudo -u oracle npm ci
sudo -u oracle npm run build

echo "== 5. .env (buat manual, JANGAN commit):"
echo "   sudo -u oracle cp .env.example .env && sudo -u oracle nano .env"

echo "== 6. Systemd =="
sudo cp deploy/oracle-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now oracle-bot

echo "== 7. Log rotate =="
sudo tee /etc/logrotate.d/oracle-bot >/dev/null <<'EOF'
/var/log/oracle-bot.log {
  daily
  rotate 14
  compress
  missingok
  notifempty
  copytruncate
}
EOF

echo "== 8. Verifikasi =="
sleep 3
sudo systemctl status oracle-bot --no-pager -l | head -15
echo
echo "Selesai. Cek log: sudo tail -f /var/log/oracle-bot.log"
