const fs = require('fs');
const path = require('path');
const { sanitizeNarratorChain, extractNarratorChainFromArabic } = require('../server');

const valid = sanitizeNarratorChain('Yahya -> Waki -> Sufyan -> Ayyub');
console.log(`Valid chain: ${valid}`);

if (valid !== 'Yahya -> Waki -> Sufyan -> Ayyub') {
  throw new Error(`Expected clean narrator chain, got "${valid}"`);
}

const invalid = sanitizeNarratorChain('This hadith reminds the reader to value the Quran and daily practice.');
console.log(`Invalid chain fallback: ${invalid}`);

if (invalid !== 'Chain not available') {
  throw new Error(`Expected invalid chain to be rejected, got "${invalid}"`);
}

const mixed = sanitizeNarratorChain('Yahya -> سعيد -> Sufyan');
console.log(`Mixed-script chain fallback: ${mixed}`);

if (mixed !== 'Chain not available') {
  throw new Error(`Expected mixed-script chain to be rejected, got "${mixed}"`);
}

const samples = [
  { file: 'bukhari.json', ref: 'bukhari:1' },
  { file: 'muslim.json', ref: 'muslim:8a' },
  { file: 'abudawud.json', ref: 'abudawud:3660' },
  { file: 'tirmidhi.json', ref: 'tirmidhi:2970' }
];

for (const sample of samples) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hadith', sample.file), 'utf8'));
  const hadith = data.hadiths.find(item => item.sunnahReference === sample.ref || item.canonicalRef === sample.ref);
  if (!hadith) throw new Error(`Could not find ${sample.ref}`);

  const chain = extractNarratorChainFromArabic(hadith.arabic);
  console.log(`${sample.ref}: ${chain}`);

  if (chain === 'Chain not available') {
    throw new Error(`Expected fallback chain for ${sample.ref}`);
  }
  if (/[\u0600-\u06FF]/.test(chain)) {
    throw new Error(`Arabic leaked into fallback chain for ${sample.ref}: ${chain}`);
  }
  if (/(?:حدثنا|أخبرنا|اخبرنا|قال|عن|سمعت)/.test(chain)) {
    throw new Error(`Transmission cue leaked into fallback chain for ${sample.ref}: ${chain}`);
  }
}
