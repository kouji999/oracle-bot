# Deploy ke Oracle Cloud Free Tier

## TL;DR
1. Signup https://signup.cloud.oracle.com (email, verifikasi email, kartu kredit untuk verifikasi — TIDAK dicharge untuk Always Free)
2. Buat VM: Shape **VM.Standard.A1.Flex** (ARM, 4 OCPU + 24GB RAM max free — pakai 2 OCPU/12GB aman), image Ubuntu 24.04, SSH key
3. Security List: buka port 22 (sumber IP lu aja lebih aman)
4. `bash deploy/setup-oracle-vm.sh` di VM
5. Copy project + `.env` → `systemctl start oracle-bot`

## Detail signup (kalau macet)
- Always Free: 2x ARM VM A1 (total 4 OCPU/24GB), 200GB block storage, 10TB egress/bln
- Kartu kredit: verifikasi identity only. Perlu nominal kecil authorize (derefund) ATAU OTP SMS. Indonesia kadang ditolak — kalau gitu cek email untuk verifikasi manual (bisa makan waktu 1-2 hari)
- OTP SMS kadang lambat 15-30 menit — jangan spam retry, bisa lock 24 jam

## Gotcha ARM
- `node:sqlite` & semua dep project ini pure JS — aman di ARM (zero native deps by design)
- Kalau npm install lambat: `npm ci --prefer-offline`

## Update bot
```bash
# di laptop:
rsync -av --exclude node_modules --exclude data --exclude .git --exclude .env ./ ubuntu@VM_IP:/tmp/oracle-push/
# di VM:
sudo rsync -a /tmp/oracle-push/ /opt/oracle-bot/ && cd /opt/oracle-bot && sudo -u oracle npm ci && sudo -u oracle npm run build && sudo systemctl restart oracle-bot
```

## Backup DB
```bash
# di VM (cron harian):
sqlite3 /opt/oracle-bot/data/oracle.db ".backup /opt/oracle-bot/data/backup-$(date +%F).db"
```
(atau cukup rsync file .db saat bot stop — WAL mode safe untuk copy live juga)
