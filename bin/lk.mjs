#!/usr/bin/env node
/**
 * Lanceur CROSS-PLATFORM de la CLI (Linux / macOS / Windows).
 *
 * Le transport Voyager tourne dans un vrai Chrome HEADFUL (empreinte non
 * détectée, requis par Cloudflare Turnstile). Un affichage est donc nécessaire
 * pour les commandes réseau :
 *   - Linux            -> on encapsule dans `xvfb-run` (faux display headless),
 *                         comportement d'origine. Bureau Linux avec écran : LK_NO_XVFB=1.
 *   - macOS / Windows  -> la session bureau fournit l'affichage, lancement direct.
 * Les commandes hors-ligne tournent toujours en direct.
 *
 * On exécute la CLI TypeScript via tsx (résolu depuis le node_modules du paquet,
 * quel que soit le répertoire courant) — pas de shell, pas de `.sh`, pas de PATH.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CLI = resolve(ROOT, 'src', 'cli.ts');

// Résout le binaire tsx depuis le node_modules DU PAQUET (indépendant du CWD).
function resolveTsxCli() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('tsx/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tsx;
  return resolve(dirname(pkgPath), binRel);
}

const NET = new Set([
  'seed-cookies', 'login', 'whoami', 'search-posts', 'search-people',
  'comments', 'campaign', 'resolve', 'resolve-pending', 'invite', 'check-accepted',
]);

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const isNet = NET.has(cmd);

// xvfb sur Linux pour les commandes réseau (headful sans écran physique),
// désactivable sur un bureau Linux avec LK_NO_XVFB=1. Direct sur macOS/Windows.
const useXvfb = isNet && process.platform === 'linux' && process.env.LK_NO_XVFB !== '1';

let tsxCli;
try {
  tsxCli = resolveTsxCli();
} catch {
  console.error('tsx introuvable. Lance `npm install` dans le dossier du projet.');
  process.exit(127);
}

const nodeCall = [tsxCli, CLI, ...args];
const [bin, spawnArgs] = useXvfb
  ? ['xvfb-run', ['-a', process.execPath, ...nodeCall]]
  : [process.execPath, nodeCall];

const child = spawn(bin, spawnArgs, { stdio: 'inherit' });

child.on('error', (e) => {
  if (useXvfb && e.code === 'ENOENT') {
    console.error(
      'xvfb-run introuvable (nécessaire pour un Linux sans écran).\n' +
        '  - Debian/Ubuntu : sudo apt-get install -y xvfb\n' +
        '  - Ou, sur un bureau Linux avec écran : relance avec LK_NO_XVFB=1',
    );
    process.exit(127);
  }
  console.error(e.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
