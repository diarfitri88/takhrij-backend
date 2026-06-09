const fs = require('fs');
const path = require('path');
const {
  separateArabicIsnadFromMatn,
  extractArabicNarratorNamesFromArabic,
  extractNarratorChainFromArabic,
  isValidNarratorBioName,
  sanitizeNarratorChain
} = require('../server');

const cases = [
  { label: 'Sahih al-Bukhari 1', file: 'bukhari.json', ref: 'bukhari:1', expectedAny: ['الحميدي', 'سفيان'] },
  { label: 'Sahih al-Bukhari 5931', file: 'bukhari.json', ref: 'bukhari:5931' },
  { label: 'Sahih Muslim 1', file: 'muslim.json', ref: 'muslim:1', optionalIfMissing: true },
  { label: 'Sahih Muslim first available local sample', file: 'muslim.json', ref: 'muslim:8a', expectedAny: ['زهير', 'وكيع'] },
  { label: 'Jami at-Tirmidhi 2970', file: 'tirmidhi.json', ref: 'tirmidhi:2970', expectedAny: ['احمد', 'هشيم'] },
  { label: 'Sunan Abi Dawud 1110', file: 'abudawud.json', ref: 'abudawud:1110', expectedAny: ['محمد بن عوف', 'سهل بن معاذ'] },
  { label: 'Sunan Abi Dawud 3660', file: 'abudawud.json', ref: 'abudawud:3660', expectedAny: ['مسدد', 'زيد بن ثابت'] },
  { label: 'Sunan Abi Dawud 9', file: 'abudawud.json', ref: 'abudawud:9', expectedAny: ['مسدد', 'الزهري'] }
];

const matnLeakPattern = /(?:الحبوة|يوم الجمعة|الامام يخطب|الإمام يخطب|لعن الله|نهى عن|قال رسول الله|قال النبي|صلى الله عليه وسلم|في كتاب الله)/;
const brokenEnglishPattern = /\b(?:Man L|al habwah|yawm al jumaa|imam yakhtub|Friday|sermon)\b/i;

function loadHadith(file, ref) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hadith', file), 'utf8'));
  return data.hadiths.find(item => item.sunnahReference === ref || item.canonicalRef === ref);
}

for (const item of cases) {
  const hadith = loadHadith(item.file, item.ref);
  if (!hadith) {
    if (item.optionalIfMissing) {
      console.log(`${item.label}: unavailable in local JSON (${item.ref})`);
      continue;
    }
    throw new Error(`${item.label}: missing ${item.ref}`);
  }

  const { isnad, matn, boundaryIndex } = separateArabicIsnadFromMatn(hadith.arabic);
  const arabicNames = extractArabicNarratorNamesFromArabic(hadith.arabic);
  const diagnosticChain = extractNarratorChainFromArabic(hadith.arabic);

  console.log(`\n${item.label}`);
  console.log(`boundaryIndex=${boundaryIndex}`);
  console.log(`arabicNames=${arabicNames.join(' -> ') || 'NONE'}`);
  console.log(`diagnosticChain=${diagnosticChain}`);

  if (!isnad || arabicNames.length < 2) {
    throw new Error(`${item.label}: expected at least two narrator names from isnad`);
  }
  if (matnLeakPattern.test(arabicNames.join(' '))) {
    throw new Error(`${item.label}: matn text leaked into Arabic narrator names`);
  }
  if (brokenEnglishPattern.test(diagnosticChain)) {
    throw new Error(`${item.label}: broken/matn English leaked into diagnostic chain`);
  }
  if (item.expectedAny && !item.expectedAny.some(text => arabicNames.join(' ').includes(text))) {
    throw new Error(`${item.label}: expected known narrator cue not found in Arabic names`);
  }
}

const unsafeNames = ['His Father', 'Man L', 'al habwah yawm al jumaa', 'Imam Yakhtub', 'A'];
for (const name of unsafeNames) {
  if (isValidNarratorBioName(name)) {
    throw new Error(`Expected "${name}" to be invalid for narrator biography lookup`);
  }
}

const safeNames = ['Abu Hurairah', 'al-Zuhri', 'Ibn Abi Dhi\'b', 'Anas'];
for (const name of safeNames) {
  if (!isValidNarratorBioName(name)) {
    throw new Error(`Expected "${name}" to be valid for narrator biography lookup`);
  }
}

if (sanitizeNarratorChain('Man L -> al habwah yawm al jumaa') !== 'Chain not available') {
  throw new Error('Expected fake/matn chain to be rejected by sanitizer');
}

console.log('\nProduction chain safety checks passed.');
