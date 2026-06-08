const fs = require('fs');
const path = require('path');
const { sanitizeNarratorChain, extractNarratorChainFromArabic } = require('../server');

const valid = sanitizeNarratorChain('Yahya -> Waki -> Sufyan -> Ayyub');
console.log(`Valid chain: ${valid}`);

if (valid !== 'Yahya -> Waki -> Sufyan -> Ayyub') {
  throw new Error(`Expected clean narrator chain, got "${valid}"`);
}

const normalized = sanitizeNarratorChain('Abu Huraira -> Al Zuhri -> Al Agharr');
console.log(`Normalized chain: ${normalized}`);

if (normalized !== 'Abu Hurairah -> al-Zuhri -> al-Agharr') {
  throw new Error(`Expected common narrator variants to be normalized, got "${normalized}"`);
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
  { file: 'bukhari.json', ref: 'bukhari:16', mustInclude: ['Ayyub', 'Abu Qilabah', 'Anas'] },
  { file: 'muslim.json', ref: 'muslim:8a' },
  { file: 'muslim.json', ref: 'muslim:13a' },
  { file: 'abudawud.json', ref: 'abudawud:3660' },
  { file: 'abudawud.json', ref: 'abudawud:1110', expected: 'Chain not available' },
  { file: 'abudawud.json', ref: 'abudawud:9' },
  { file: 'tirmidhi.json', ref: 'tirmidhi:2970' }
];

for (const sample of samples) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hadith', sample.file), 'utf8'));
  const hadith = data.hadiths.find(item => item.sunnahReference === sample.ref || item.canonicalRef === sample.ref);
  if (!hadith) throw new Error(`Could not find ${sample.ref}`);

  const chain = extractNarratorChainFromArabic(hadith.arabic);
  console.log(`${sample.ref}: ${chain}`);

  if (sample.expected) {
    if (chain !== sample.expected) {
      throw new Error(`Expected ${sample.ref} chain to be "${sample.expected}", got "${chain}"`);
    }
    continue;
  }

  if (chain === 'Chain not available') {
    throw new Error(`Expected fallback chain for ${sample.ref}`);
  }
  if (/[^\x00-\x7F]/.test(chain)) {
    throw new Error(`Non-ASCII text leaked into fallback chain for ${sample.ref}: ${chain}`);
  }
  if (/(?:haddathana|akhbarana|qala|sami'tu)/i.test(chain)) {
    throw new Error(`Transmission cue leaked into fallback chain for ${sample.ref}: ${chain}`);
  }
  if (sample.mustInclude) {
    for (const expected of sample.mustInclude) {
      if (!chain.includes(expected)) {
        throw new Error(`Expected ${sample.ref} chain to include "${expected}", got "${chain}"`);
      }
    }
  }
}
