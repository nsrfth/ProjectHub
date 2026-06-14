/**
 * One-off generator: builds backend/src/data/ir-holidays.json from the
 * static offline files bundled in npm package `shamsi-holidays` (time.ir
 * official holiday dates, years 1404–1406). Run manually when refreshing:
 *   node scripts/generate-ir-holidays.mjs
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const staticDir = path.join(
  path.dirname(require.resolve('shamsi-holidays')),
  'static-holidays-data',
);

/** Fixed solar national holidays (starcal / official calendar). */
const SOLAR = {
  '1/1': { name: 'جشن نوروز / سال نو', type: 'national', recurring: true },
  '1/2': { name: 'عید نوروز', type: 'national', recurring: true },
  '1/3': { name: 'عید نوروز', type: 'national', recurring: true },
  '1/4': { name: 'عید نوروز', type: 'national', recurring: true },
  '1/12': { name: 'روز جمهوری اسلامی', type: 'national', recurring: true },
  '1/13': { name: 'روز طبیعت (سیزده‌بدر)', type: 'national', recurring: true },
  '3/14': { name: 'رحلت امام خمینی', type: 'national', recurring: true },
  '3/15': { name: 'قیام ۱۵ خرداد', type: 'national', recurring: true },
  '11/22': { name: 'پیروزی انقلاب اسلامی', type: 'national', recurring: true },
  '12/29': { name: 'ملی شدن صنعت نفت', type: 'national', recurring: true },
};

const YEARS = [1404, 1405, 1406];
const out = [];

for (const year of YEARS) {
  const file = path.join(staticDir, `holidays${year}.json`);
  const dates = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const raw of dates) {
    const [y, m, d] = raw.split('/').map(Number);
    const key = `${m}/${d}`;
    const meta = SOLAR[key] ?? {
      name: 'تعطیل رسمی',
      type: 'religious',
      recurring: false,
    };
    out.push({
      jalaliYear: y,
      jalaliMonth: m,
      jalaliDay: d,
      name: meta.name,
      type: meta.type,
      recurring: meta.recurring,
    });
  }
}

const dest = path.join(__dirname, '../src/data/ir-holidays.json');
fs.writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`Wrote ${out.length} entries to ${dest}`);
