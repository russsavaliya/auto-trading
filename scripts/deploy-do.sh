#!/usr/bin/env bash
# Push this working tree to the DigitalOcean droplet and restart the bridge.
#
#   bash scripts/deploy-do.sh          # refuses while the market is open
#   FORCE=1 bash scripts/deploy-do.sh  # deploy anyway
#
# The droplet's /opt/bridge/.env is never touched — secrets live only there.
# A restart mid-session drops any webhook that lands during the ~5s it takes,
# and pauses the premium stop-loss monitor, hence the market-hours guard.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@64.227.153.201}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/do_trading}"
PUBLIC_URL="${DEPLOY_URL:-https://139-59-52-230.sslip.io}"

cd "$(dirname "$0")/.."

if [ "${FORCE:-0}" != "1" ] && curl -fsS -m 10 "$PUBLIC_URL/health" | grep -q '"market_open":true'; then
  echo "Market is open — not restarting the bridge. Re-run with FORCE=1 to override." >&2
  exit 1
fi

tar czf - --exclude=node_modules --exclude=.git --exclude=.env \
  --exclude=auto-trading-frontend --exclude=research --exclude='*.log' . |
  ssh -i "$KEY" -o BatchMode=yes "$HOST" '
    set -e
    # Unpack beside the live tree first, so a broken upload never leaves
    # /opt/bridge half-written; --delete then drops files removed locally.
    rm -rf /opt/bridge.next && mkdir /opt/bridge.next
    tar xzf - -C /opt/bridge.next
    rsync -a --delete --exclude=/.env --exclude=/node_modules /opt/bridge.next/ /opt/bridge/
    rm -rf /opt/bridge.next
    chown -R app:app /opt/bridge
    cd /opt/bridge && sudo -u app npm ci --omit=dev --no-audit --no-fund --loglevel=error
    systemctl restart bridge
    sleep 6
    systemctl is-active bridge
  '

curl -fsS -m 15 "$PUBLIC_URL/health"
echo
