import { readFile, writeFile, copyFile, mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const buildDir = new URL('../../firmware-arduino/.pio/build/m5stack-cardputer-easy/', import.meta.url);
const outputDir = new URL('../public/firmware/', import.meta.url);
const app = await readFile(new URL('firmware.bin', buildDir));
if (!app.includes(Buffer.from('/ws/byok')) || app.includes(Buffer.from('/ws/esp32\0'))) {
  throw new Error('Only the credential-free EASY build can be packaged publicly.');
}
if (/AIza[A-Za-z0-9_-]{35}/.test(app.toString('latin1'))) {
  throw new Error('A provider credential pattern was found in the image.');
}
await mkdir(outputDir, { recursive: true });
const parts = [
  { source: new URL('bootloader.bin', buildDir), path: 'bootloader.bin', offset: 0 },
  { source: new URL('partitions.bin', buildDir), path: 'partitions.bin', offset: 0x8000 },
  { source: join(homedir(), '.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin'), path: 'boot_app0.bin', offset: 0xe000 },
  { source: new URL('firmware.bin', buildDir), path: 'cardputer-voice-easy.bin', offset: 0x10000 },
];
const checksums = [];
for (const part of parts) {
  const data = await readFile(part.source);
  await copyFile(part.source, new URL(part.path, outputDir));
  checksums.push(`${createHash('sha256').update(data).digest('hex')}  ${part.path}`);
}
await writeFile(new URL('SHA256SUMS.txt', outputDir), `${checksums.join('\n')}\n`);
await writeFile(new URL('manifest.json', outputDir), `${JSON.stringify({
  name: 'Cardputer Voice Easy', version: '0.3.2', new_install_prompt_erase: true,
  builds: [{ chipFamily: 'ESP32-S3', serialType: 'cdc', parts: parts.map(({ path, offset }) => ({ path, offset })) }],
}, null, 2)}\n`);
await build({
  entryPoints: [fileURLToPath(new URL('../node_modules/esp-web-tools/dist/web/install-button.js', import.meta.url))],
  outfile: fileURLToPath(new URL('../public/install-button.js', import.meta.url)),
  bundle: true, format: 'esm', target: 'es2022', minify: true, legalComments: 'eof',
});
const visited = new Set();
const notices = [];
async function collectLicenses(packageDir) {
  if (visited.has(packageDir)) return;
  visited.add(packageDir);
  const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  notices.push(`${metadata.name} ${metadata.version} (${metadata.license || 'see notice'})`);
  for (const name of await readdir(packageDir)) {
    if (/^(license|copying|notice|copyright)([._-].*)?$/i.test(name)) {
      notices.push(await readFile(join(packageDir, name), 'utf8'));
    }
  }
  for (const dependency of Object.keys(metadata.dependencies || {})) {
    let parent = packageDir;
    while (true) {
      const candidate = join(parent, 'node_modules', dependency);
      try { await readFile(join(candidate, 'package.json')); await collectLicenses(candidate); break; }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const next = dirname(parent);
        if (next === parent) throw new Error(`Missing installer dependency: ${dependency}`);
        parent = next;
      }
    }
  }
}
await collectLicenses(fileURLToPath(new URL('../node_modules/esp-web-tools/', import.meta.url)));
await writeFile(new URL('../public/installer-LICENSE.txt', import.meta.url), `${notices.join('\n\n').trimEnd()}\n`);
console.log(`Packaged credential-free EASY firmware (${app.length} bytes), checksums, and the pinned USB installer.`);
