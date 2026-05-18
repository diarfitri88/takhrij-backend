const { extractAuthenticityStatus } = require('../server');

const tirmidhi2970SourceText = [
  'ولا يصح من قبل إسناده',
  'إسناده ضعيف',
  'شيخ مجهول'
].join(' ');

const result = extractAuthenticityStatus(
  { arabic: tirmidhi2970SourceText, collection: 'tirmidhi' },
  'tirmidhi',
  tirmidhi2970SourceText
);

console.log(`Tirmidhi 2970 authenticity status: ${result.status}`);

if (!/weak|not authentic|caution/i.test(result.status)) {
  throw new Error(`Expected weak/cautioned status for Tirmidhi 2970, got "${result.status}"`);
}
