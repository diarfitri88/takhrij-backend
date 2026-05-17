const { formatDidYouMeanFallback } = require('../server');

const output = formatDidYouMeanFallback('yassin', [
  'recite quran at night',
  'virtues of recitation',
  'heart remembers Allah'
]);

console.log(output);

if (!output.includes('Did you mean:')) {
  throw new Error('Expected Did you mean section');
}

if (/Authenticity Status:/i.test(output)) {
  throw new Error('Fallback must not include an authenticity status');
}

if (/\b(?:sahih|hasan|weak|authentic|fabricated|albani|ibn hajar)\b/i.test(output)) {
  throw new Error('Fallback must not include grading language');
}
