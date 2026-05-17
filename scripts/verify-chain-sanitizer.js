const { sanitizeNarratorChain } = require('../server');

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
