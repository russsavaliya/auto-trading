'use strict';

/**
 * Copies variables from the local .env to the droplet's /opt/bridge/.env and
 * restarts the bridge.
 *
 *   node scripts/set-server-env.js UPSTOX_SANDBOX_ACCESS_TOKEN
 *   node scripts/set-server-env.js KEY1 KEY2 --force   # restart even while the market is open
 *
 * A DigitalOcean droplet has no environment-variable screen the way Render or
 * Vercel do — the server's settings live only in that file, so this is how
 * they change. The sandbox token alone needs it every 30 days.
 *
 * Values travel over ssh and are never printed. The server file is replaced
 * in one rename, so a dropped connection cannot leave it half-written.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOST = process.env.DEPLOY_HOST || 'root@64.227.153.201';
const KEY = process.env.DEPLOY_KEY || path.join(os.homedir(), '.ssh', 'do_trading');
const PUBLIC_URL = process.env.DEPLOY_URL || 'https://139-59-52-230.sslip.io';
const SERVER_ENV = '/opt/bridge/.env';

function ssh(command, input) {
  const r = spawnSync('ssh', ['-i', KEY, '-o', 'BatchMode=yes', HOST, command], {
    input,
    encoding: 'utf8',
  });
  if (r.error) throw new Error(`could not run ssh: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ssh failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

/** Last assignment wins, matching how the server reads the file. */
function readLocal(keys) {
  const lines = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/);
  const values = {};
  for (const k of keys) {
    const line = lines.filter((l) => l.startsWith(`${k}=`)).pop();
    if (line === undefined) throw new Error(`${k} is not set in the local .env`);
    values[k] = line.slice(k.length + 1);
  }
  return values;
}

function merge(serverText, values) {
  const pending = { ...values };
  const out = serverText
    .split(/\r?\n/)
    .filter((l, i, all) => !(i === all.length - 1 && l === ''))
    .map((l) => {
      const k = l.split('=', 1)[0];
      if (!(k in values)) return l;
      delete pending[k];
      return `${k}=${values[k]}`;
    });
  for (const [k, v] of Object.entries(pending)) out.push(`${k}=${v}`);
  return `${out.join('\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const keys = args.filter((a) => a !== '--force');
  if (!keys.length) throw new Error('usage: node scripts/set-server-env.js KEY [KEY...] [--force]');

  const values = readLocal(keys);

  if (!force) {
    const health = await fetch(`${PUBLIC_URL}/health`).then((r) => r.json()).catch(() => ({}));
    if (health.market_open) throw new Error('market is open — not restarting the bridge. Re-run with --force to override.');
  }

  const merged = merge(ssh(`cat ${SERVER_ENV}`), values);
  const state = ssh(
    `cat > ${SERVER_ENV}.new && chown app:app ${SERVER_ENV}.new && chmod 600 ${SERVER_ENV}.new && ` +
      `mv ${SERVER_ENV}.new ${SERVER_ENV} && systemctl restart bridge && sleep 6 && systemctl is-active bridge`,
    merged
  );

  console.log(`Updated on the server: ${keys.join(', ')} — bridge ${state.trim()}`);
  const health = await fetch(`${PUBLIC_URL}/health`).then((r) => r.json());
  console.log(`Health: ${health.status} | live token: ${health.live && health.live.token_state}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
