import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const stageRoot = path.join(root, 'release');
const stageDir = path.join(stageRoot, 'MultiAI-Answer');
const zipPath = path.join(stageRoot, `MultiAI-Answer-v${version}.zip`);

const requiredFiles = [
  'manifest.json',
  'icons/icon.png',
  'lib/html2canvas.min.js',
  'dist/background.js',
  'dist/content.js',
  'dist/auth-content.js',
  'src/popup/popup.html',
  'src/popup/popup.js',
  'src/content/utils/notification.js',
];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) {
    throw new Error(`Packaging stopped: required file is missing: ${file}. Run npm run build and check the repository.`);
  }
}

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

for (const dir of ['icons', 'lib', 'dist']) {
  fs.cpSync(path.join(root, dir), path.join(stageDir, dir), { recursive: true });
}
for (const file of ['manifest.json']) {
  fs.copyFileSync(path.join(root, file), path.join(stageDir, file));
}
for (const file of ['src/popup/popup.html', 'src/popup/popup.js', 'src/content/utils/notification.js']) {
  const destination = path.join(stageDir, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, file), destination);
}

fs.rmSync(zipPath, { force: true });
if (process.platform === 'win32') {
  const escaped = zipPath.replace(/'/g, "''");
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -LiteralPath '${stageDir}' -DestinationPath '${escaped}' -Force`,
  ], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-qr', zipPath, 'MultiAI-Answer'], { cwd: stageRoot, stdio: 'inherit' });
}

if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
  throw new Error('ZIP packaging failed: output archive is missing or empty.');
}
console.log(`Packaged successfully: ${path.relative(root, zipPath)}`);
console.log('Load the extracted MultiAI-Answer folder in chrome://extensions (Developer mode).');
