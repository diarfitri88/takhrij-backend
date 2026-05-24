const { spawn } = require('child_process');

const PORT = 3137;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return response.json();
    } catch (_) {
      // Server is still starting.
    }
    await sleep(500);
  }
  throw new Error('Backend did not become healthy in time');
}

async function search(query) {
  const response = await fetch(`${BASE_URL}/search-hadith`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`Search failed for "${query}" with ${response.status}`);
  const payload = await response.json();
  return payload;
}

function resultText(payload) {
  return String(payload.result || '');
}

function firstReference(payload) {
  return (resultText(payload).match(/^Reference: .+$/m) || [''])[0];
}

function firstStructuredReference(payload) {
  return payload.results?.[0]?.reference || '';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  try {
    await waitForHealth();

    const bukhariSpace = await search('bukhari 755');
    assert(
      firstReference(bukhariSpace) === 'Reference: Sahih al-Bukhari 755',
      `"bukhari 755" should return canonical Sahih al-Bukhari 755, got ${firstReference(bukhariSpace)}`
    );
    assert(
      firstStructuredReference(bukhariSpace) === 'Sahih al-Bukhari 755',
      `"bukhari 755" should include structured results[0].reference, got ${firstStructuredReference(bukhariSpace)}`
    );

    const bukhariColon = await search('bukhari:755');
    assert(
      firstReference(bukhariColon) === 'Reference: Sahih al-Bukhari 755',
      `"bukhari:755" should return canonical Sahih al-Bukhari 755, got ${firstReference(bukhariColon)}`
    );

    const bukhariText = await search('Suq Ukaz devils news heaven');
    assert(
      firstReference(bukhariText) === 'Reference: Sahih al-Bukhari 773',
      `Text/local search for local id 755 should display Sahih al-Bukhari 773, got ${firstReference(bukhariText)}`
    );

    const muslim = await search('muslim 1165b');
    assert(
      firstReference(muslim) === 'Reference: Sahih Muslim 1165 b',
      `"muslim 1165b" should return Sahih Muslim 1165 b, got ${firstReference(muslim)}`
    );
    assert(
      firstStructuredReference(muslim) === 'Sahih Muslim 1165 b',
      `"muslim 1165b" should include structured results[0].reference, got ${firstStructuredReference(muslim)}`
    );

    const tirmidhi = await search('tirmidhi 2970');
    assert(
      firstReference(tirmidhi) === 'Reference: Jami` at-Tirmidhi 2970',
      `"tirmidhi 2970" should return Jami\` at-Tirmidhi 2970, got ${firstReference(tirmidhi)}`
    );

    const abuDawud = await search('abu dawud 1');
    assert(
      firstReference(abuDawud) === 'Reference: Sunan Abi Dawud 1',
      `"abu dawud 1" should return Sunan Abi Dawud 1, got ${firstReference(abuDawud)}`
    );

    const nasai = await search('nasai 499');
    assert(
      firstReference(nasai) === "Reference: Sunan an-Nasa'i 499",
      `"nasai 499" should return Sunan an-Nasa'i 499, got ${firstReference(nasai)}`
    );

    const malik = await search('malik 1');
    assert(
      firstReference(malik) === 'Reference: Muwatta Malik Book 1, Hadith 1',
      `"malik 1" should return Muwatta Malik Book 1, Hadith 1, got ${firstReference(malik)}`
    );

    const ahmad = await search('musnad ahmad 1');
    assert(
      firstReference(ahmad) === 'Reference: Musnad Ahmad 1',
      `"musnad ahmad 1" should return Musnad Ahmad 1, got ${firstReference(ahmad)}`
    );

    console.log(JSON.stringify({
      status: 'ok',
      checks: {
        bukhari755: firstReference(bukhariSpace),
        bukhariColon755: firstReference(bukhariColon),
        localId755TextSearch: firstReference(bukhariText),
        muslim1165b: firstReference(muslim),
        tirmidhi2970: firstReference(tirmidhi),
        abuDawud1: firstReference(abuDawud),
        nasai499: firstReference(nasai),
        malik1: firstReference(malik),
        ahmad1: firstReference(ahmad),
      },
    }, null, 2));
  } finally {
    child.kill();
    if (stderr && process.env.DEBUG_CANONICAL_REF_TEST) {
      console.error(stderr);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
