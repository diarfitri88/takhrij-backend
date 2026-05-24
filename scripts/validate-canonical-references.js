const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const hadithDir = path.join(root, 'hadith');
const reportDir = path.join(root, 'reference-audit-20260524-170714', 'reports');
const unresolvedPath = path.join(reportDir, 'unresolved-references.json');
const duplicatePath = path.join(reportDir, 'duplicate-canonical-references.json');

const files = [
  'abudawud.json',
  'ahmed.json',
  'bukhari.json',
  'darimi.json',
  'ibnmajah.json',
  'malik.json',
  'muslim.json',
  'nasai.json',
  'tirmidhi.json',
];

function readRows(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(payload) ? payload : payload.hadiths;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const unresolved = JSON.parse(fs.readFileSync(unresolvedPath, 'utf8'));
const duplicateCanonical = JSON.parse(fs.readFileSync(duplicatePath, 'utf8'));
const summary = {};

for (const file of files) {
  const collection = file.replace('.json', '');
  const rows = readRows(path.join(hadithDir, file));
  const backupRows = readRows(path.join(root, 'reference-audit-20260524-170714', 'backup', file));
  let repaired = 0;
  let unresolvedCount = 0;
  let bookUnknown = 0;
  const seen = new Map();

  rows.forEach((h, index) => {
    assert(h.id !== undefined, `${file} row ${index} is missing local id`);
    assert(
      backupRows[index]?.id === h.id && backupRows[index]?.idInBook === h.idInBook,
      `${file} row ${index} no longer preserves local id/idInBook`
    );

    if (h.reference) repaired += 1;
    if (!h.reference) unresolvedCount += 1;
    if (String(h.reference || '').includes('Book Unknown')) bookUnknown += 1;

    if (h.sunnahReference) {
      const refs = seen.get(h.sunnahReference) || [];
      refs.push({ index, id: h.id, reference: h.reference });
      seen.set(h.sunnahReference, refs);
    }
  });

  summary[collection] = {
    rows: rows.length,
    repaired,
    unresolved: unresolvedCount,
    bookUnknown,
    duplicateCanonicalReferences: [...seen.values()].filter(refs => refs.length > 1).length,
  };

  assert(bookUnknown === 0, `${file} still contains Book Unknown references`);
}

const bukhariRows = readRows(path.join(hadithDir, 'bukhari.json'));
const localId755 = bukhariRows.find(h => h.id === 755);
assert(localId755, 'Bukhari local id 755 was not found');
assert(
  localId755.reference === 'Sahih al-Bukhari 773',
  `Bukhari local id 755 should display Sahih al-Bukhari 773, got ${localId755.reference}`
);
assert(
  localId755.sunnahReference === 'bukhari:773',
  `Bukhari local id 755 should map to bukhari:773, got ${localId755.sunnahReference}`
);

const bukhari755 = bukhariRows.find(h => h.sunnahReference === 'bukhari:755');
assert(bukhari755, 'Canonical bukhari:755 was not found');
assert(
  bukhari755.id === 737,
  `Canonical bukhari:755 should map to local id 737, got ${bukhari755.id}`
);

console.log(JSON.stringify({
  status: 'ok',
  summary,
  unresolvedReportEntries: unresolved.length,
  duplicateCanonicalReportEntries: duplicateCanonical.length,
  bukhariLocalId755: {
    id: localId755.id,
    reference: localId755.reference,
    sunnahReference: localId755.sunnahReference,
  },
}, null, 2));
