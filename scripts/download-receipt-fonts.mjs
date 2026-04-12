/**
 * PDF баримтын кирилл/₮ дэмжлэгтэй Noto Sans TTF татах (PDFKit).
 * Ажиллуулах: node scripts/download-receipt-fonts.mjs
 */
import { createWriteStream, mkdirSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '../assets/fonts');

const files = [
  ['NotoSans-Regular.ttf', 'https://raw.githubusercontent.com/googlefonts/noto-fonts/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf'],
  ['NotoSans-Bold.ttf', 'https://raw.githubusercontent.com/googlefonts/noto-fonts/main/hinted/ttf/NotoSans/NotoSans-Bold.ttf'],
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          download(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} ${url}`));
          return;
        }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

mkdirSync(outDir, { recursive: true });
for (const [name, url] of files) {
  const dest = join(outDir, name);
  await download(url, dest);
  const size = statSync(dest).size;
  if (size < 10_000) throw new Error(`Invalid font file: ${name} (${size} bytes)`);
  console.log(`OK ${name} (${size} bytes)`);
}
