// File: server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const Fuse = require("fuse.js");
const fs = require('fs');
const path = require('path');

const app = express();
const mutawatirData = JSON.parse(fs.readFileSync(path.join(__dirname, 'mutawatir.json'), 'utf8'));

app.use(cors());
app.use(express.json({ limit: "64kb" }));

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 30000;
const MAX_QUERY_LENGTH = 300;
const MAX_TEXT_FIELD_LENGTH = 4000;
const USE_LIGHT_SEARCH = String(process.env.USE_LIGHT_SEARCH || 'true').toLowerCase() !== 'false';

// ─── 0) CACHE FOR COMMENTARY ───────────────────────────────────────────────────
const commentaryCache = new Map();
const MAX_COMMENTARY_CACHE_ENTRIES = 250;
const COMMENTARY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COMMENTARY_CACHE_VERSION = 'lessons-benefits-spaced-v9-gpt-chain-fallback-transliteration';

// ─── RATE LIMITING (Rolling 24-hour limit per IP) ───────────────────────────────
const aiCallTracker = new Map(); // { 'IP': { count: x, lastReset: timestamp } }

const MAX_CALLS = 5;
const TIME_LIMIT = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

function checkAiLimit(ip) {
  const now = Date.now();

  if (!aiCallTracker.has(ip)) {
    aiCallTracker.set(ip, { count: 0, lastReset: now });
  }

  const entry = aiCallTracker.get(ip);

  // Reset if 24 hours passed since lastReset
  if (now - entry.lastReset >= TIME_LIMIT) {
    entry.count = 0;
    entry.lastReset = now;
  }

  if (entry.count >= MAX_CALLS) {
    return false; // Limit reached
  }

  entry.count++;
  return true; // Allowed
}

function pruneAiCallTracker() {
  const cutoff = Date.now() - TIME_LIMIT;
  for (const [ip, entry] of aiCallTracker.entries()) {
    if (entry.lastReset < cutoff) aiCallTracker.delete(ip);
  }
}

function getCachedCommentary(cacheKey) {
  const cached = commentaryCache.get(cacheKey);
  if (!cached) return null;

  if (Date.now() - cached.createdAt > COMMENTARY_CACHE_TTL_MS) {
    commentaryCache.delete(cacheKey);
    return null;
  }

  return cached.payload;
}

function setCachedCommentary(cacheKey, payload) {
  // Bound the in-memory cache so repeated commentary requests cannot grow the process forever.
  commentaryCache.set(cacheKey, { payload, createdAt: Date.now() });
  if (commentaryCache.size > MAX_COMMENTARY_CACHE_ENTRIES) {
    const oldestKey = commentaryCache.keys().next().value;
    commentaryCache.delete(oldestKey);
  }
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip
    || req.socket.remoteAddress
    || 'unknown';
}

function cleanInput(value, maxLength = MAX_TEXT_FIELD_LENGTH) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, maxLength);
}

async function callOpenRouter(messages, { max_tokens, temperature }) {
  if (!process.env.OPENROUTER_API_KEY) {
    const err = new Error("OPENROUTER_API_KEY is not configured");
    err.statusCode = 503;
    throw err;
  }

  // Keep OpenRouter access centralized so timeouts, model choice, and response guards stay consistent.
  const response = await axios.post(
    OPENROUTER_URL,
    {
      model: OPENROUTER_MODEL,
      messages,
      max_tokens,
      temperature
    },
    {
      timeout: OPENROUTER_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return cleanInput(response.data?.choices?.[0]?.message?.content || "", 12000);
}
// ─── 1) HELPER: Truncate long text to 500 chars ───────────────────────────────
function truncate(text, max = 500) {
  text = typeof text === 'string' ? text : '';
  const singleLine = text.replace(/[\r\n]+/g, ' ');
  return singleLine.length > max
    ? singleLine.slice(0, max).trim() + '…'
    : singleLine;
}

// ─── 2) STOP-WORDS & KEYWORD EXTRACTION ────────────────────────────────────────
const STOP_WORDS = new Set([
  "hadith", "about", "the", "a", "an", "and", "of", "in", "on", "for", "to"
]);

function extractKeywords(query) {
  return query
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter(w => w.length > 2 && !STOP_WORDS.has(w)) || [];
}

// ─── 3) HELPER: normalize text for searching ────────────────────────────────────
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u064B-\u065F]/g, '')       // remove Arabic diacritics
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '') // strip punctuation
    .replace(/\s{2,}/g, ' ')               // collapse multiple spaces
    .trim();
}

// ─── HELPER: Check if Hadith is Mutawatir ───────────────────────────────────────
function checkMutawatir(reference) {
  return mutawatirData.mutawatirHadiths.find(h => 
    h.reference.some(r => reference.toLowerCase().includes(r.toLowerCase()))
  ) || null;
}

// ─── 4) LOAD HADITH COLLECTIONS ────────────────────────────────────────────────
// Keep combined search data cached after startup; rebuilding it per request is costly for large JSON collections.
let allHadithsCache = [];
let fuseDataCache = [];
const collectionCounts = {};
let firstSearchMemoryLogged = false;

const urls = {
  bukhari:   "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/bukhari.json?alt=media&token=f0c30d22-2041-41c1-ae4e-84d82749ec5d",
  muslim:    "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/muslim.json?alt=media&token=7058eff8-198e-465a-ab66-9d32f53d4bc1",
  tirmidhi:  "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/tirmidhi.json?alt=media&token=5a845700-747a-40a2-b902-d3d3ae16b743",
  nasai:     "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/nasai.json?alt=media&token=69dc6f6d-57b1-4441-a7a7-ad560899d31d",
  malik:     "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/malik.json?alt=media&token=8f843e5d-022c-4437-ae9c-f1957b65effa",
  ibnmajah:  "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/ibnmajah.json?alt=media&token=a57e3ba0-c1b1-4e56-8a20-4a64b524b9eb",
  darimi:    "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/darimi.json?alt=media&token=8be756c6-28fb-4c85-882d-9c9f28ba891d",
  ahmed:     "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/ahmed.json?alt=media&token=2df2c5aa-6239-4a90-b838-806fde91324b",
  abudawud:  "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/abudawud.json?alt=media&token=ac71e9bb-ac98-4187-b11d-4bf7fa458174"
};

const localHadithFiles = {
  bukhari:   path.join(__dirname, "hadith", "bukhari.json"),
  muslim:    path.join(__dirname, "hadith", "muslim.json"),
  tirmidhi:  path.join(__dirname, "hadith", "tirmidhi.json"),
  nasai:     path.join(__dirname, "hadith", "nasai.json"),
  malik:     path.join(__dirname, "hadith", "malik.json"),
  ibnmajah:  path.join(__dirname, "hadith", "ibnmajah.json"),
  darimi:    path.join(__dirname, "hadith", "darimi.json"),
  ahmed:     path.join(__dirname, "hadith", "ahmed.json"),
  abudawud:  path.join(__dirname, "hadith", "abudawud.json")
};

const localExtraHadithFiles = {
  shamail_muhammadiyah: path.join(__dirname, "data", "extraHadith", "shamail_muhammadiyah.json"),
  riyad_assalihin: path.join(__dirname, "data", "extraHadith", "riyad_assalihin.json"),
  mishkat_almasabih: path.join(__dirname, "data", "extraHadith", "mishkat_almasabih.json"),
  bulugh_almaram: path.join(__dirname, "data", "extraHadith", "bulugh_almaram.json"),
  aladab_almufrad: path.join(__dirname, "data", "extraHadith", "aladab_almufrad.json"),
  qudsi40: path.join(__dirname, "data", "extraHadith", "qudsi40.json"),
  nawawi40: path.join(__dirname, "data", "extraHadith", "nawawi40.json")
};

function readHadithRows(payload) {
  return Array.isArray(payload) ? payload : (Array.isArray(payload.hadiths) ? payload.hadiths : []);
}

function logMemoryUsage(label) {
  const mb = value => `${Math.round(value / 1024 / 1024)}MB`;
  const usage = process.memoryUsage();
  console.log(
    `[memory] ${label}: rss=${mb(usage.rss)} heapUsed=${mb(usage.heapUsed)} heapTotal=${mb(usage.heapTotal)} external=${mb(usage.external)}`
  );
}

function logFirstSearchMemoryUsage() {
  if (firstSearchMemoryLogged) return;
  firstSearchMemoryLogged = true;
  logMemoryUsage("after first search");
}

function compactHadithRecord(collectionId, h = {}, overrides = {}) {
  const englishObject = h.english && typeof h.english === 'object' ? h.english : {};
  const englishText = h.englishText || englishObject.text || englishObject.body || (typeof h.english === 'string' ? h.english : '') || h.text || h.body || '';
  const englishNarrator = h.englishNarrator || englishObject.narrator || '';
  const arabicText = h.arabicText || h.arabic || '';
  const hadithNumber = h.hadithNumber ?? h.idInBook ?? h.hadithnumber ?? h.number ?? overrides.hadithNumber ?? null;

  return {
    collection: collectionId,
    localHadithId: h.localHadithId ?? h.id ?? null,
    idInBook: h.idInBook ?? hadithNumber,
    hadithNumber,
    bookNumber: h.bookNumber ?? null,
    bookName: h.bookName || '',
    hadithInBook: h.hadithInBook || '',
    bookId: h.bookId ?? null,
    chapterId: h.chapterId ?? null,
    chapterTitleEnglish: overrides.chapterTitleEnglish || h.chapterTitleEnglish || '',
    chapterTitleArabic: overrides.chapterTitleArabic || h.chapterTitleArabic || '',
    collectionTitleEnglish: overrides.collectionTitleEnglish || h.collectionTitleEnglish || names[collectionId] || '',
    collectionTitleArabic: overrides.collectionTitleArabic || h.collectionTitleArabic || '',
    collectionAuthorEnglish: overrides.collectionAuthorEnglish || h.collectionAuthorEnglish || '',
    collectionAuthorArabic: overrides.collectionAuthorArabic || h.collectionAuthorArabic || '',
    arabicText,
    englishText,
    englishNarrator,
    reference: overrides.reference || h.reference || '',
    sunnahReference: h.sunnahReference || h.canonicalRef || '',
    canonicalRef: h.canonicalRef || '',
    sunnahUrl: h.sunnahUrl || '',
    grade: h.grade || englishObject.grade || '',
    grading: h.grading || englishObject.grading || '',
    classification: h.classification || englishObject.classification || '',
    authenticity: h.authenticity || '',
    status: h.status || '',
    sourceFile: overrides.sourceFile || h.sourceFile || ''
  };
}

function normalizeLocalExtraHadith(collectionId, sourceFile, payload) {
  const metadata = payload?.metadata || {};
  const chapters = Array.isArray(payload?.chapters) ? payload.chapters : [];
  const hadiths = readHadithRows(payload);
  const chapterById = new Map(chapters.map(chapter => [String(chapter.id), chapter]));
  const collectionTitleArabic = metadata?.arabic?.title || '';
  const collectionTitleEnglish = metadata?.english?.title || collectionId;
  const collectionAuthorArabic = metadata?.arabic?.author || '';
  const collectionAuthorEnglish = metadata?.english?.author || '';

  return hadiths.map(hadith => {
    const chapter = chapterById.get(String(hadith.chapterId)) || {};
    const hadithNumber = hadith.idInBook;
    const reference = `${collectionTitleEnglish} ${hadithNumber}`;

    return compactHadithRecord(collectionId, hadith, {
      hadithNumber,
      reference,
      collectionTitleArabic,
      collectionTitleEnglish,
      collectionAuthorArabic,
      collectionAuthorEnglish,
      chapterTitleArabic: chapter.arabic || '',
      chapterTitleEnglish: chapter.english || '',
      sourceFile
    });
  });
}

function loadLocalExtraHadiths() {
  const loaded = [];

  Object.entries(localExtraHadithFiles).forEach(([collectionId, filePath]) => {
    const sourceFile = path.basename(filePath);
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const normalized = normalizeLocalExtraHadith(collectionId, sourceFile, payload);
      collectionCounts[collectionId] = normalized.length;
      console.log(`Loaded local extra hadith collection ${sourceFile}: ${normalized.length}`);
      loaded.push(...normalized);
    } catch (err) {
      console.error(`Failed to load local extra hadith file ${sourceFile}: ${err.message}`);
    }
  });

  console.log(`Total local extra hadith loaded: ${loaded.length}`);
  return loaded;
}

async function loadCollectionRows(collection) {
  const localPath = localHadithFiles[collection];
  try {
    const localPayload = JSON.parse(fs.readFileSync(localPath, "utf8"));
    return readHadithRows(localPayload);
  } catch (localErr) {
    console.warn(`Local hadith file unavailable for ${collection}; falling back to remote source.`);
    const response = await axios.get(urls[collection], { timeout: 20000 });
    return readHadithRows(response.data);
  }
}

async function loadHadiths() {
  try {
    const collections = Object.keys(urls);
    const combined = [];

    for (const collection of collections) {
      const rows = await loadCollectionRows(collection);
      const normalized = rows.map(h => compactHadithRecord(collection, h));
      collectionCounts[collection] = normalized.length;
      combined.push(...normalized);
      console.log(`Loaded hadith collection ${collection}: ${normalized.length}`);
    }

    allHadithsCache = combined;
    console.log("Base hadith collections loaded.");
    logMemoryUsage("after Firebase collections load");

    const localExtraHadiths = loadLocalExtraHadiths();
    allHadithsCache.push(...localExtraHadiths);
    logMemoryUsage("after local extra collections load");

    console.log(`Total combined hadith loaded: ${allHadithsCache.length}`);
    initFuse();
  } catch (err) {
    console.error("Failed to load hadiths:", err.message);
  }
}
if (require.main === module) {
  loadHadiths();
}

const names = {
  bukhari:   "Sahih al-Bukhari",
  muslim:    "Sahih Muslim",
  tirmidhi:  "Jami` at-Tirmidhi",
  nasai:     "Sunan an-Nasa'i",
  malik:     "Muwatta Malik",
  ibnmajah:  "Sunan Ibn Majah",
  darimi:    "Sunan ad-Darimi",
  ahmed:     "Musnad Ahmad",
  abudawud:  "Sunan Abi Dawud",
  shamail_muhammadiyah: "Shama'il Muhammadiyah",
  riyad_assalihin: "Riyad as-Salihin",
  mishkat_almasabih: "Mishkat al-Masabih",
  bulugh_almaram: "Bulugh al-Maram",
  aladab_almufrad: "Al-Adab Al-Mufrad",
  qudsi40: "The Forty Hadith Qudsi",
  nawawi40: "The Forty Hadith of Imam Nawawi"
};

const refFormatters = {
  default: () => "Reference under review"
};

function getEnglishText(h) {
  if (typeof h.englishText === "string") return h.englishText;
  if (typeof h.english === "string") return h.english;
  if (h.english && typeof h.english === "object") return h.english.text || h.english.body || "";
  if (typeof h.text === "string") return h.text;
  if (typeof h.body === "string") return h.body;
  return "";
}

function getHadithReference(h) {
  if (h?.reference && !String(h.reference).includes("Book Unknown")) return h.reference;
  return (refFormatters[h?.collection] || refFormatters.default)(h);
}

function getSunnahReferenceNumber(h) {
  const canonical = String(h?.sunnahReference || h?.canonicalRef || '');
  return (canonical.match(/:(\d+[a-z]?)/i) || [])[1] || '';
}

function hasCanonicalReference(h) {
  return Boolean(h?.sunnahReference || h?.canonicalRef || h?.sunnahUrl || h?.reference);
}

function getPublicReferenceTokens(h) {
  const tokens = [
    getSunnahReferenceNumber(h),
    String(h.sunnahUrl || '').match(/:(\d+[a-z]?)/i)?.[1],
    String(h.canonicalRef || '').match(/:(\d+[a-z]?)/i)?.[1],
    ...String(h.reference || '').match(/\d+\s*[a-z]?/gi) || []
  ];

  return tokens
    .filter(Boolean)
    .map(value => String(value).replace(/\s+/g, '').toLowerCase());
}

function normalizeCollectionKey(value = '') {
  const input = String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases = {
    bukhari: 'bukhari',
    sahihbukhari: 'bukhari',
    sahihalbukhari: 'bukhari',
    muslim: 'muslim',
    sahihmuslim: 'muslim',
    sahihalmuslim: 'muslim',
    tirmidhi: 'tirmidhi',
    jamitirmidhi: 'tirmidhi',
    jamiattirmidhi: 'tirmidhi',
    jamiatttirmidhi: 'tirmidhi',
    jamiatirmidhi: 'tirmidhi',
    nasai: 'nasai',
    nasaii: 'nasai',
    annasai: 'nasai',
    alnasaai: 'nasai',
    alnasai: 'nasai',
    sunannasai: 'nasai',
    malik: 'malik',
    muwattamalik: 'malik',
    ibnmajah: 'ibnmajah',
    sunanibnmajah: 'ibnmajah',
    darimi: 'darimi',
    addarimi: 'darimi',
    aldarimi: 'darimi',
    sunandarimi: 'darimi',
    ahmed: 'ahmed',
    ahmad: 'ahmed',
    musnadahmad: 'ahmed',
    abudawud: 'abudawud',
    abudawood: 'abudawud',
    abidawood: 'abudawud',
    abidawud: 'abudawud',
    sunanabudawud: 'abudawud',
    sunanabudawood: 'abudawud',
    sunanabidawud: 'abudawud',
    shamail: 'shamail_muhammadiyah',
    shamailmuhammadiyah: 'shamail_muhammadiyah',
    shamailmuhammad: 'shamail_muhammadiyah',
    riyadassalihin: 'riyad_assalihin',
    riyadussalihin: 'riyad_assalihin',
    riyadalsalihin: 'riyad_assalihin',
    riyad: 'riyad_assalihin',
    mishkat: 'mishkat_almasabih',
    mishkatalmasabih: 'mishkat_almasabih',
    mishkatalmisbah: 'mishkat_almasabih',
    bulugh: 'bulugh_almaram',
    bulughalmaram: 'bulugh_almaram',
    aladabalmufrad: 'aladab_almufrad',
    adabalmufrad: 'aladab_almufrad',
    adabmufrad: 'aladab_almufrad',
    qudsi40: 'qudsi40',
    fortyhadithqudsi: 'qudsi40',
    hadithqudsi40: 'qudsi40',
    nawawi40: 'nawawi40',
    fortyhadithnawawi: 'nawawi40',
    arbainnawawi: 'nawawi40'
  };

  return aliases[input] || value;
}

function inferCollectionFromReference(reference = '') {
  const normalized = String(reference).toLowerCase();
  if (normalized.includes('bukhari')) return 'bukhari';
  if (normalized.includes('muslim')) return 'muslim';
  if (normalized.includes('tirmidhi')) return 'tirmidhi';
  if (normalized.includes('nasa')) return 'nasai';
  if (normalized.includes('dawud') || normalized.includes('dawood')) return 'abudawud';
  if (normalized.includes('ibn majah')) return 'ibnmajah';
  if (normalized.includes('malik')) return 'malik';
  if (normalized.includes('ahmad') || normalized.includes('ahmed')) return 'ahmed';
  if (normalized.includes('darimi')) return 'darimi';
  if (normalized.includes('shamail')) return 'shamail_muhammadiyah';
  if (normalized.includes('riyad')) return 'riyad_assalihin';
  if (normalized.includes('mishkat')) return 'mishkat_almasabih';
  if (normalized.includes('bulugh')) return 'bulugh_almaram';
  if (normalized.includes('adab')) return 'aladab_almufrad';
  if (normalized.includes('qudsi')) return 'qudsi40';
  if (normalized.includes('nawawi')) return 'nawawi40';
  return '';
}

function parseReferenceQuery(query = '') {
  const original = String(query || '').trim();
  if (!original) return null;

  const normalized = original
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\bal[-\s]+/g, 'al ')
    .replace(/[:#]/g, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokenMatch = normalized.match(/\b(\d+\s*[a-z]?)\b$/i);
  if (!tokenMatch) return null;

  const referenceToken = tokenMatch[1].replace(/\s+/g, '').toLowerCase();
  const collectionText = normalized.slice(0, tokenMatch.index).trim();
  if (!collectionText) return null;

  const collectionKey = normalizeCollectionKey(collectionText);
  if (!names[collectionKey]) return null;

  return { collectionKey, referenceToken };
}

function normalizeArabicForDetection(value = '') {
  return String(value)
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u0625\u0623\u0622]/g, '\u0627')
    .replace(/\u0649/g, '\u064a')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0640/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findHadithByReference(reference, collection) {
  const collectionKey = normalizeCollectionKey(collection || inferCollectionFromReference(reference));
  const referenceText = String(reference || '').toLowerCase();
  const referenceToken = (referenceText.match(/\d+\s*[a-z]?/gi) || []).pop()?.replace(/\s+/g, '').toLowerCase();

  const candidates = allHadithsCache.filter(h => !collectionKey || h.collection === collectionKey);

  const exactMatch = candidates.find(h => {
    const knownReference = getHadithReference(h).toLowerCase();
    const canonicalFields = [
      h.sunnahReference,
      h.canonicalRef,
      h.sunnahUrl
    ].filter(Boolean).map(value => String(value).toLowerCase());

    return knownReference === referenceText || canonicalFields.includes(referenceText);
  });
  if (exactMatch) return exactMatch;

  const canonicalNumberMatch = candidates.find(h => {
    return referenceToken && getPublicReferenceTokens(h).includes(referenceToken);
  });
  if (canonicalNumberMatch) return canonicalNumberMatch;

  return candidates.find(h => {
    if (collectionKey && h.collection !== collectionKey) return false;

    if (hasCanonicalReference(h)) return false;

    // Last-resort compatibility for records still awaiting canonical mapping.
    // Public display and exact matching above use canonical Sunnah.com references.
    const hadithNumbers = [h.hadithNumber, h.idInBook, h.localHadithId]
      .filter(Boolean)
      .map(value => String(value));

    return referenceToken && hadithNumbers.includes(referenceToken);
  }) || null;
}

function extractAuthenticityStatus(h, collection, sourceOverride = '') {
  const collectionKey = normalizeCollectionKey(collection || h?.collection);

  if (['bukhari', 'muslim'].includes(collectionKey)) {
    return {
      status: 'Sahih by collection',
      source: `${names[collectionKey]} collection metadata`,
      caution: ''
    };
  }

  const explicitFields = [
    h?.grade,
    h?.grading,
    h?.classification,
    h?.authenticity,
    h?.status,
    h?.english?.grade,
    h?.english?.grading,
    h?.english?.classification
  ].filter(Boolean).join(' ');

  const sourceText = `${explicitFields} ${getEnglishText(h || {})} ${h?.arabicText || h?.arabic || ''} ${sourceOverride}`;
  const normalizedArabicSource = normalizeArabicForDetection(sourceText);
  const source = explicitFields ? 'structured source field' : 'explicit source text';
  const arabicHas = pattern => new RegExp(pattern).test(normalizedArabicSource);
  const hasExplicitWeakPhrase =
    /\b(?:da['‘’]?if|daeef|weak)\b/i.test(explicitFields) ||
    /\b(?:graded|classed|classified|declared|marked|ruled)\s+(?:as\s+)?(?:da['‘’]?if|daeef|weak)\b/i.test(sourceText) ||
    /\b(?:da['‘’]?if|daeef|weak)\s*\)/i.test(sourceText) ||
    arabicHas('\\u062d\\u062f\\u064a\\u062b\\s+\\u0636\\u0639\\u064a\\u0641') ||
    arabicHas('\\u0627\\u0633\\u0646\\u0627\\u062f\\u0647\\s+\\u0636\\u0639\\u064a\\u0641') ||
    arabicHas('\\u0636\\u0639\\u0641\\u0647');
  const hasExplicitNotAuthenticPhrase =
    arabicHas('\\u0644\\u0627\\s+\\u064a\\u0635\\u062d');
  const hasExplicitHasanSahihPhrase =
    /\b(?:graded|classed|classified|declared|marked|ruled)\s+(?:as\s+)?hasan\s+sahih\b/i.test(sourceText) ||
    /\bhasan\s+sahih\b/i.test(explicitFields) ||
    arabicHas('\\u062d\\u0633\\u0646\\s+\\u0635\\u062d\\u064a\\u062d');
  const hasExplicitSahihPhrase =
    /\b(?:graded|classed|classified|declared|marked|ruled)\s+(?:as\s+)?sahih\b/i.test(sourceText) ||
    /\bsahih\s*\)/i.test(sourceText) ||
    /\bsahih\b/i.test(explicitFields) ||
    arabicHas('\\u0635\\u062d\\u062d\\u0647') ||
    arabicHas('\\u062d\\u062f\\u064a\\u062b\\s+\\u0635\\u062d\\u064a\\u062d');
  const hasExplicitHasanPhrase =
    /\b(?:graded|classed|classified|declared|marked|ruled)\s+(?:as\s+)?hasan\b/i.test(sourceText) ||
    /\bhasan\s*\)/i.test(sourceText) ||
    /\bhasan\b/i.test(explicitFields) ||
    arabicHas('\\u062d\\u062f\\u064a\\u062b\\s+\\u062d\\u0633\\u0646');
  const hasExplicitGharibPhrase =
    /\bgharib\b/i.test(explicitFields) ||
    /\b(?:graded|classed|classified|declared|marked|ruled)\s+(?:as\s+)?gharib\b/i.test(sourceText) ||
    arabicHas('\\u062d\\u062f\\u064a\\u062b\\s+\\u063a\\u0631\\u064a\\u0628') ||
    arabicHas('\\u0644\\u0627\\s+\\u0646\\u0639\\u0631\\u0641\\u0647\\s+\\u0627\\u0644\\u0627\\s+\\u0645\\u0646\\s+\\u0647\\u0630\\u0627\\s+\\u0627\\u0644\\u0648\\u062c\\u0647');
  const hasExplicitCautionPhrase =
    arabicHas('\\u0645\\u0646\\u0643\\u0631') ||
    arabicHas('\\u0634\\u064a\\u062e\\s+\\u0645\\u062c\\u0647\\u0648\\u0644');

  // This only surfaces explicit grading phrases already present in local/source data; GPT is not asked to grade.
  if (hasExplicitWeakPhrase) {
    return {
      status: "Weak (explicitly mentioned in source text)",
      source,
      caution: 'This source text includes an explicit weakness note. Treat the commentary as educational background only and verify religious use with qualified scholars.'
    };
  }

  if (hasExplicitNotAuthenticPhrase) {
    return {
      status: 'Not authentic (explicitly mentioned in source text)',
      source,
      caution: 'This source text includes an explicit authenticity caution. Treat the commentary as educational background only and verify religious use with qualified scholars.'
    };
  }

  if (hasExplicitHasanSahihPhrase) {
    return { status: 'Hasan Sahih (mentioned in source text)', source, caution: '' };
  }

  if (hasExplicitSahihPhrase) {
    return { status: 'Sahih (mentioned in source text)', source, caution: '' };
  }

  if (hasExplicitHasanPhrase) {
    return { status: 'Hasan (mentioned in source text)', source, caution: '' };
  }

  if (hasExplicitGharibPhrase) {
    return { status: 'Gharib (explicitly mentioned in source text)', source, caution: '' };
  }

  if (hasExplicitCautionPhrase) {
    return {
      status: 'Caution noted in source text',
      source,
      caution: 'This source text includes an explicit caution phrase. Treat the commentary as educational background only and verify religious use with qualified scholars.'
    };
  }

  return {
    status: 'Not specified in source',
    source: 'available source metadata/text',
    caution: ''
  };
}

function sanitizeNarratorBio(rawBio = '') {
  const forbiddenPattern = /\b(scholarly remarks|jarh|ta['‘’]?dil|grading|grade|graded|authenticity|trustworthy|reliable|unreliable|weak|thiqah|liar|fabricator|majhul|abandoned|criticism|dispute|disputed)\b/i;
  const allowedLabels = [
    'birth/death',
    'place/region',
    'region',
    'teachers',
    'students',
    'interesting fact'
  ];
  const sectionValues = new Map();
  let currentLabel = null;

  String(rawBio)
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .forEach(line => {
      const labelMatch = line.match(/^(?:\*\*)?([^:*]+):(?:\*\*)?\s*(.*)$/);
      if (labelMatch) {
        const label = labelMatch[1].trim().toLowerCase();
        currentLabel = allowedLabels.includes(label) ? label : null;

        if (currentLabel) {
          const value = labelMatch[2].trim();
          if (value && !forbiddenPattern.test(value)) {
            sectionValues.set(currentLabel, value);
          }
        }
        return;
      }

      if (currentLabel && !forbiddenPattern.test(line)) {
        const existing = sectionValues.get(currentLabel);
        sectionValues.set(currentLabel, existing ? `${existing} ${line}` : line);
      }
    });

  const safeSections = [
    ['Birth/Death', sectionValues.get('birth/death')],
    ['Place/Region', sectionValues.get('place/region') || sectionValues.get('region')],
    ['Teachers', sectionValues.get('teachers')],
    ['Students', sectionValues.get('students')],
    ['Interesting Fact', sectionValues.get('interesting fact')]
  ];

  return safeSections
    .map(([label, value]) => `${label}:\n\n${value || 'Not clearly available.'}`)
    .join('\n\n');
}

function stripSectionHeading(text = '', headingPattern) {
  return String(text)
    .replace(new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?${headingPattern}(?:\\*\\*)?\\s*[:：-]?\\s*`, 'i'), '')
    .trim();
}

function normalizeCommonNarratorTransliteration(name = '') {
  return String(name || '')
    .replace(/\bAywb\b/gi, 'Ayyub')
    .replace(/\bAby\s+Qlabah\b/gi, 'Abu Qilabah')
    .replace(/\bQlabah\b/gi, 'Qilabah')
    .replace(/\bZhdm\s+Aljrmy\b/gi, 'Zahdam al-Jarmi')
    .replace(/\bAljrmy\b/gi, 'al-Jarmi')
    .replace(/\bAlmthna\b/gi, 'al-Muthanna')
    .replace(/\bBd\s+Alwhab\b/gi, 'Abd al-Wahhab')
    .replace(/\bAlwhab\b/gi, 'al-Wahhab')
    .replace(/\bAlthqfy\b/gi, 'al-Thaqafi')
    .replace(/\bAlmthna\b/gi, 'al-Muthanna')
    .replace(/\bAns\b/g, 'Anas')
    .replace(/\bNmyr\b/gi, 'Numayr')
    .replace(/\bUmarw\b/gi, 'Amr')
    .replace(/\bThman\b/gi, 'Uthman')
    .replace(/\bTlhah\b/gi, 'Talhah')
    .replace(/\bAbuh\b/gi, 'His Father')
    .replace(/\bMsrhd\b/gi, 'Musarhad')
    .replace(/\bTa\b/g, 'Ata')
    .replace(/\bYzyd\b/gi, 'Yazid')
    .replace(/\bRwayah\b/gi, '')
    .replace(/\bAby\s+Aywb\b/gi, 'Abu Ayyub')
    .replace(/\bAby\s+Hurayrah\b/gi, 'Abu Hurairah')
    .replace(/\bAby\s+Said\b/gi, 'Abu Said')
    .replace(/\bAby\s+Hashm\b/gi, 'Abu Hashim')
    .replace(/\bAby\b/gi, 'Abu')
    .replace(/\bAbu\s+Hur(?:ai|ei|ay)ra(?:h)?\b/gi, 'Abu Hurairah')
    .replace(/\bAbu\s+Hureira(?:h)?\b/gi, 'Abu Hurairah')
    .replace(/\bAbu\s+Huryra(?:h)?\b/gi, 'Abu Hurairah')
    .replace(/\bAbu\s+Hurayrah\b/gi, 'Abu Hurairah')
    .replace(/\bAl\s+Zuhri\b/gi, 'al-Zuhri')
    .replace(/\bAz\s+Zuhri\b/gi, 'al-Zuhri')
    .replace(/\bAl-Zuhri\b/g, 'al-Zuhri')
    .replace(/\bAl\s+Agharr\b/gi, 'al-Agharr')
    .replace(/\bAl-Agharr\b/g, 'al-Agharr')
    .replace(/\bAl\s+Ansari\b/gi, 'al-Ansari')
    .replace(/\bAl-Ansari\b/g, 'al-Ansari')
    .replace(/\bAl\s+Taymi\b/gi, 'al-Taymi')
    .replace(/\bAl-Taymi\b/g, 'al-Taymi')
    .replace(/\bAl\s+Laythi\b/gi, 'al-Laythi')
    .replace(/\bAl-Laythi\b/g, 'al-Laythi')
    .replace(/\bAl\s+Shabi\b/gi, 'al-Shabi')
    .replace(/\bAl-Shabi\b/g, 'al-Shabi')
    .replace(/\bAl\s+Khattab\b/gi, 'al-Khattab')
    .replace(/\bAl-Khattab\b/g, 'al-Khattab')
    .replace(/\bAl\s+Jarmi\b/gi, 'al-Jarmi')
    .replace(/\bAl-Jarmi\b/g, 'al-Jarmi')
    .replace(/\bAl\s+Muthanna\b/gi, 'al-Muthanna')
    .replace(/\bAl-Muthanna\b/g, 'al-Muthanna')
    .replace(/\bAl\s+Wahhab\b/gi, 'al-Wahhab')
    .replace(/\bAl-Wahhab\b/g, 'al-Wahhab')
    .replace(/\bAl\s+Thaqafi\b/gi, 'al-Thaqafi')
    .replace(/\bAl-Thaqafi\b/g, 'al-Thaqafi')
    .replace(/\bAisha\b/gi, 'Aishah')
    .replace(/\bMuaz\b/gi, 'Muadh')
    .replace(/\s+/g, ' ')
    .trim();
}

function isReadableFallbackNarratorName(name = '') {
  const cleaned = String(name || '').trim();
  if (!cleaned || cleaned.length > 55 || /[^\x00-\x7F]/.test(cleaned)) return false;

  const roughFragments = /\b(?:Byd|Abyh|Aljrmy|Alwhab|Qlabah|Msrhd|Hshym|Zhdm|Almqry|Mrhwm|Alhbwah|Aljmah|Walamam|Ykhtb|Wf|Shl)\b/i;
  if (roughFragments.test(cleaned)) return false;

  const allowedShortWords = new Set(['al', 'ibn', 'bin']);
  const words = cleaned
    .replace(/[.-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return false;

  return words.every(word => {
    const lower = word.toLowerCase();
    if (allowedShortWords.has(lower)) return true;
    if (lower.length <= 2) return false;
    if (lower.length >= 4 && !/[aeiou]/i.test(lower)) return false;
    return true;
  });
}

function sanitizeNarratorChain(chain = '') {
  const cleaned = String(chain || '')
    .replace(/\*\*/g, '')
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)[0]
    .split(/(?:Lessons\s*&\s*Benefits|Commentary|Explanation|Educational Commentary|Meaning|Evaluation of Hadith|Fiqh Ruling)\s*[:\uFF1A-]?/i)[0]
    .trim();

  if (!cleaned || /^no chain\.?$/i.test(cleaned) || /^chain not available\.?$/i.test(cleaned)) {
    return 'Chain not available';
  }

  const hasChainDelimiter = /(?:->|\u2192|=>|,|;|\u060C)/.test(cleaned);
  if (!hasChainDelimiter) {
    return 'Chain not available';
  }

  const sentencePattern = /[.!?]|\b(?:hadith|narration|report|meaning|lesson|benefit|reader|practice|authenticity|source|reward|virtue|specific|claim)\b/i;
  const names = cleaned
    .split(/\s*(?:->|\u2192|=>|,|;|\u060C)\s*/)
    .map(name => name.replace(/^\d+\.\s*/, '').trim())
    .map(normalizeCommonNarratorTransliteration)
    .filter(Boolean);

  if (
    names.length < 2 ||
    names.length > 20 ||
    names.some(name => name.length > 55 || sentencePattern.test(name) || /[\u0600-\u06FF]/.test(name) || /\s{2,}/.test(name))
  ) {
    return 'Chain not available';
  }

  return names.join(' -> ');
}

const ARABIC_TRANSMISSION_CUE_PATTERN = '(?:\\u062D\\u062F\\u062B\\u0646\\u0627|\\u062D\\u062F\\u062B\\u0646\\u064A|[\\u0623\\u0627]\\u062E\\u0628\\u0631\\u0646\\u0627|[\\u0623\\u0627]\\u062E\\u0628\\u0631\\u0646\\u064A|[\\u0623\\u0627]\\u0646\\u0628[\\u0623\\u0627]\\u0646\\u0627|\\u0639\\u0646(?=\\s)|\\u0633\\u0645\\u0639\\u062A|\\u0633\\u0645\\u0639)';
const ARABIC_TRANSMISSION_CUE_REGEX = new RegExp(ARABIC_TRANSMISSION_CUE_PATTERN, 'g');
const ARABIC_PROPHET_STOP_REGEX = new RegExp('^(?:\\u0631\\u0633\\u0648\\u0644 \\u0627\\u0644\\u0644\\u0647|\\u0627\\u0644\\u0646\\u0628\\u064A|\\u0627\\u0644\\u0644\\u0647 \\u062A\\u0628\\u0627\\u0631\\u0643|\\u0627\\u0644\\u0644\\u0647 \\u0639\\u0632 \\u0648\\u062C\\u0644)');

function normalizeArabicForChain(text = '') {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArabicNarratorName(name = '') {
  return normalizeArabicForChain(name)
    .replace(/[\u060C,\u061B;.:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\u062D\s+\u0648\s+/, '')
    .replace(/(?:^|\s)\u062D(?:\s+\u0648)?(?:\s|$)/g, ' ')
    .replace(new RegExp('^' + ARABIC_TRANSMISSION_CUE_PATTERN + '\\s+'), '')
    .replace(/\u0645\u0646 \u0648\u0644\u062F[\s\S]*$/g, '')
    .replace(/\u0631\u0648\u0627\u064A\u0629/g, '')
    .replace(/(?:\u0631\u0636\u064A \u0627\u0644\u0644\u0647(?: \u0639\u0646\u0647\u0645\u0627| \u0639\u0646\u0647)?|\u0631\u0636\u0649 \u0627\u0644\u0644\u0647(?: \u0639\u0646\u0647\u0645\u0627| \u0639\u0646\u0647)?|\u0631\u062D\u0645\u0647 \u0627\u0644\u0644\u0647|\u0635\u0644\u0649 \u0627\u0644\u0644\u0647 \u0639\u0644\u064A\u0647 \u0648\u0633\u0644\u0645|\u0639\u0644\u064A\u0647 \u0627\u0644\u0633\u0644\u0627\u0645)/g, '')
    .trim();
}

function transliterateArabicLetters(text = '') {
  const map = {
    '\u0621': '', '\u0622': 'a', '\u0623': 'a', '\u0624': 'u', '\u0625': 'i', '\u0626': 'i', '\u0627': 'a',
    '\u0628': 'b', '\u0629': 'ah', '\u062A': 't', '\u062B': 'th', '\u062C': 'j', '\u062D': 'h', '\u062E': 'kh',
    '\u062F': 'd', '\u0630': 'dh', '\u0631': 'r', '\u0632': 'z', '\u0633': 's', '\u0634': 'sh', '\u0635': 's',
    '\u0636': 'd', '\u0637': 't', '\u0638': 'z', '\u0639': '', '\u063A': 'gh', '\u0641': 'f', '\u0642': 'q',
    '\u0643': 'k', '\u0644': 'l', '\u0645': 'm', '\u0646': 'n', '\u0647': 'h', '\u0648': 'w', '\u0649': 'a',
    '\u064A': 'y', '\u0671': 'a', '\u067E': 'p', '\u0686': 'ch', '\u06A9': 'k', '\u06AF': 'g', '\u06CC': 'y'
  };
  return String(text || '')
    .split('')
    .map(char => map[char] ?? char)
    .join('')
    .replace(/\b(al)\s+/gi, 'al-')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasArabicScript(text = '') {
  return /[\u0600-\u06FF]/.test(String(text || ''));
}

function polishTransliteratedNarratorName(name = '') {
  const smallWords = new Set(['ibn', 'bin', 'bint', 'al']);
  return String(name || '')
    .replace(/\bAbd Allah\b/g, 'Abdullah')
    .replace(/\bAbw\b/gi, 'Abu')
    .replace(/\bKhythmah\b/gi, 'Khaythamah')
    .replace(/\bZhyr\b/gi, 'Zuhayr')
    .replace(/\bHrb\b/gi, 'Harb')
    .replace(/\bKhms\b/gi, 'Kahmas')
    .replace(/\bBrydah\b/gi, 'Buraydah')
    .replace(/\bYumar\b/gi, "Ya'mar")
    .replace(/\bByd Allh\b/gi, 'Ubayd Allah')
    .replace(/\bMadh\b/gi, 'Muadh')
    .replace(/\bMsdd\b/gi, 'Musaddad')
    .replace(/\bSlyman\b/gi, 'Sulayman')
    .replace(/\bAbyh\b/gi, 'His Father')
    .replace(/\bZyd\b/gi, 'Zayd')
    .replace(/\bThabt\b/gi, 'Thabit')
    .replace(/\bAhmd\b/gi, 'Ahmad')
    .replace(/\bMny\b/gi, 'Mani')
    .replace(/\bHshym\b/gi, 'Hushaym')
    .replace(/\bHsyn\b/gi, 'Husayn')
    .replace(/\bAlshby\b/gi, 'al-Shabi')
    .replace(/\bDy\b/gi, 'Adi')
    .replace(/\bHatm\b/gi, 'Hatim')
    .replace(/\bSyd\b/gi, 'Said')
    .replace(/\bAlansary\b/gi, 'al-Ansari')
    .replace(/\bAbrahym\b/gi, 'Ibrahim')
    .replace(/\bAltymy\b/gi, 'al-Taymi')
    .replace(/\bLqmah\b/gi, 'Alqamah')
    .replace(/\bWqas\b/gi, 'Waqqas')
    .replace(/\bAllythy\b/gi, 'al-Laythi')
    .replace(/\bIbn\b/g, 'ibn')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word, index) => {
      if (!word) return word;
      if (word.startsWith('al-')) return 'al-' + word.slice(3, 4).toUpperCase() + word.slice(4).toLowerCase();
      if (index > 0 && smallWords.has(word.toLowerCase())) return word.toLowerCase();
      return word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function transliterateArabicNarratorName(name = '') {
  const replacements = [
    ['\\u0639\\u0628\\u062F \\u0627\\u0644\\u0644\\u0647', 'Abd Allah'], ['\\u0639\\u0628\\u062F \\u0627\\u0644\\u0631\\u062D\\u0645\\u0646', 'Abd al-Rahman'],
    ['\\u0639\\u0628\\u062F \\u0627\\u0644\\u0648\\u0647\\u0627\\u0628', 'Abd al-Wahhab'], ['\\u0627\\u0644\\u0645\\u062B\\u0646\\u0649', 'al-Muthanna'],
    ['\\u0627\\u0644\\u062B\\u0642\\u0641\\u064A', 'al-Thaqafi'], ['\\u0627\\u0644\\u062C\\u0631\\u0645\\u064A', 'al-Jarmi'],
    ['\\u0623\\u0628\\u064A \\u0642\\u0644\\u0627\\u0628\\u0629', 'Abu Qilabah'], ['\\u0627\\u0628\\u064A \\u0642\\u0644\\u0627\\u0628\\u0629', 'Abu Qilabah'],
    ['\\u0632\\u0647\\u062F\\u0645', 'Zahdam'], ['\\u0623\\u0628\\u0648', 'Abu'], ['\\u0627\\u0628\\u0648', 'Abu'], ['\\u0623\\u0628\\u064A', 'Abu'], ['\\u0627\\u0628\\u064A', 'Abu'],
    ['\\u0627\\u0628\\u0646', 'ibn'], ['\\u0628\\u0646', 'ibn'], ['\\u0628\\u0646\\u062A', 'bint'],
    ['\\u0627\\u0644\\u062D\\u0645\\u064A\\u062F\\u064A', 'al-Humaydi'], ['\\u0627\\u0644\\u0632\\u0647\\u0631\\u064A', 'al-Zuhri'], ['\\u0633\\u0641\\u064A\\u0627\\u0646', 'Sufyan'],
    ['\\u064A\\u062D\\u064A\\u0649', 'Yahya'], ['\\u0648\\u0643\\u064A\\u0639', 'Waki'], ['\\u0645\\u0627\\u0644\\u0643', 'Malik'], ['\\u0623\\u0646\\u0633', 'Anas'], ['\\u0627\\u0646\\u0633', 'Anas'],
    ['\\u0639\\u0645\\u0631', 'Umar'], ['\\u062D\\u0641\\u0635', 'Hafs'], ['\\u0639\\u0627\\u0626\\u0634\\u0629', 'Aishah'], ['\\u0623\\u064A\\u0648\\u0628', 'Ayyub'],
    ['\\u0627\\u064A\\u0648\\u0628', 'Ayyub'],
    ['\\u0645\\u062D\\u0645\\u062F', 'Muhammad'], ['\\u0625\\u0628\\u0631\\u0627\\u0647\\u064A\\u0645', 'Ibrahim'], ['\\u0625\\u0633\\u0645\\u0627\\u0639\\u064A\\u0644', 'Ismail'],
    ['\\u0645\\u0648\\u0633\\u0649', 'Musa'], ['\\u0647\\u0634\\u0627\\u0645', 'Hisham'], ['\\u0642\\u062A\\u064A\\u0628\\u0629', 'Qutaybah'], ['\\u0625\\u0633\\u062D\\u0627\\u0642', 'Ishaq'],
    ['\\u0645\\u0639\\u0645\\u0631', 'Mamar'], ['\\u0634\\u0639\\u0628\\u0629', 'Shubah'], ['\\u0627\\u0644\\u0623\\u0639\\u0645\\u0634', 'al-Amash'],
    ['\\u062C\\u0631\\u064A\\u0631', 'Jarir'], ['\\u0646\\u0627\\u0641\\u0639', 'Nafi'], ['\\u0633\\u0627\\u0644\\u0645', 'Salim'], ['\\u062C\\u0627\\u0628\\u0631', 'Jabir'],
    ['\\u0647\\u0631\\u064A\\u0631\\u0629', 'Hurayrah'], ['\\u0627\\u0644\\u0632\\u0628\\u064A\\u0631', 'al-Zubayr'], ['\\u0627\\u0644\\u062E\\u0637\\u0627\\u0628', 'al-Khattab']
  ];
  let transliterated = cleanArabicNarratorName(name);
  for (const [pattern, replacement] of replacements) {
    transliterated = transliterated.replace(new RegExp(pattern, 'g'), replacement);
  }
  if (hasArabicScript(transliterated)) {
    transliterated = transliterateArabicLetters(transliterated);
  }
  return normalizeCommonNarratorTransliteration(polishTransliteratedNarratorName(transliterated.replace(/\s+/g, ' ').trim()));
}

function extractNarratorChainFromArabic(arabic = '') {
  const text = normalizeArabicForChain(arabic);
  ARABIC_TRANSMISSION_CUE_REGEX.lastIndex = 0;
  if (!ARABIC_TRANSMISSION_CUE_REGEX.test(text)) {
    return 'Chain not available';
  }

  ARABIC_TRANSMISSION_CUE_REGEX.lastIndex = 0;
  const matches = [...text.matchAll(ARABIC_TRANSMISSION_CUE_REGEX)];
  const names = [];

  for (let index = 0; index < matches.length; index += 1) {
    const cue = matches[index][0];
    const routePrefix = text.slice(Math.max(0, matches[index].index - 6), matches[index].index);
    if (index > 0 && names.length >= 2 && /\u062D\s+\u0648\s*$/.test(routePrefix)) break;

    const start = matches[index].index + cue.length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const segment = text.slice(start, end).trim();

    if (!segment) continue;
    if (ARABIC_PROPHET_STOP_REGEX.test(segment)) break;
    if (cue === '\u0633\u0645\u0639\u062A' && ARABIC_PROPHET_STOP_REGEX.test(segment)) break;

    const name = cleanArabicNarratorName(segment.split(/(?:(?:^|\s)[\u0623\u0627]\u0646\s+|(?:^|\s)[\u0623\u0627]\u0646\u0647\s*|\u064A\u0642\u0648\u0644|\u0639\u0644\u0649 \u0627\u0644\u0645\u0646\u0628\u0631|\u0648\u0647\u0630\u0627 \u062D\u062F\u064A\u062B\u0647|\u064A\u0639\u0646\u064A|\u0642\u0627\u0644|\u0631\u0633\u0648\u0644 \u0627\u0644\u0644\u0647|\u0627\u0644\u0646\u0628\u064A)/)[0]);
    if (
      name &&
      name.length >= 2 &&
      name.length <= 70 &&
      !/(?:\u0643\u062A\u0627\u0628|\u0628\u0627\u0628|\u062D\u062F\u064A\u062B|\u0631\u0633\u0648\u0644 \u0627\u0644\u0644\u0647|\u0627\u0644\u0646\u0628\u064A)/.test(name)
    ) {
      names.push(transliterateArabicNarratorName(name));
      const afterQal = segment.split(/\u0642\u0627\u0644(?:\u0627)?/)[1] || '';
      const afterQalMeaningful = afterQal.replace(/[\s:\u060C,.\-]+/g, '');
      const continuesWithTransmission = new RegExp('^\\s*(?:[:\u060C,.-]\\s*)?' + ARABIC_TRANSMISSION_CUE_PATTERN).test(afterQal);
      if (names.length >= 2 && afterQalMeaningful && !continuesWithTransmission) break;
    }
  }

  const invalidNamePattern = /(?:\u0627\u0644\u0627\u0633\u0644\u0627\u0645|\u0627\u0644\u0627\u064A\u0645\u0627\u0646|\u0627\u0644\u0627\u062D\u0633\u0627\u0646|\u0627\u0644\u0633\u0627\u0639\u0629|\u0627\u0645\u0627\u0631\u062A\u0647\u0627|\u0628\u0627\u0639\u0644\u0645|\u064A\u0645\u064A\u0646\u0647)/;
  const uniqueNames = names.filter((name, index, array) => name && !invalidNamePattern.test(name) && array.indexOf(name) === index).slice(0, 20);
  if (uniqueNames.some(name => !isReadableFallbackNarratorName(name))) {
    return 'Chain not available';
  }

  return uniqueNames.length >= 2 ? uniqueNames.join(' -> ') : 'Chain not available';
}

function extractArabicNarratorNamesFromArabic(arabic = '') {
  const text = normalizeArabicForChain(arabic);
  ARABIC_TRANSMISSION_CUE_REGEX.lastIndex = 0;
  if (!ARABIC_TRANSMISSION_CUE_REGEX.test(text)) {
    return [];
  }

  ARABIC_TRANSMISSION_CUE_REGEX.lastIndex = 0;
  const matches = [...text.matchAll(ARABIC_TRANSMISSION_CUE_REGEX)];
  const names = [];

  for (let index = 0; index < matches.length; index += 1) {
    const cue = matches[index][0];
    const routePrefix = text.slice(Math.max(0, matches[index].index - 6), matches[index].index);
    if (index > 0 && names.length >= 2 && /\u062D\s+\u0648\s*$/.test(routePrefix)) break;

    const start = matches[index].index + cue.length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const segment = text.slice(start, end).trim();

    if (!segment) continue;
    if (ARABIC_PROPHET_STOP_REGEX.test(segment)) break;
    if (cue === '\u0633\u0645\u0639\u062A' && ARABIC_PROPHET_STOP_REGEX.test(segment)) break;

    const name = cleanArabicNarratorName(segment.split(/(?:(?:^|\s)[\u0623\u0627]\u0646\s+|(?:^|\s)[\u0623\u0627]\u0646\u0647\s*|\u064A\u0642\u0648\u0644|\u0639\u0644\u0649 \u0627\u0644\u0645\u0646\u0628\u0631|\u0648\u0647\u0630\u0627 \u062D\u062F\u064A\u062B\u0647|\u064A\u0639\u0646\u064A|\u0642\u0627\u0644|\u0631\u0633\u0648\u0644 \u0627\u0644\u0644\u0647|\u0627\u0644\u0646\u0628\u064A)/)[0]);
    if (
      name &&
      name.length >= 2 &&
      name.length <= 70 &&
      !/(?:\u0643\u062A\u0627\u0628|\u0628\u0627\u0628|\u062D\u062F\u064A\u062B|\u0631\u0633\u0648\u0644 \u0627\u0644\u0644\u0647|\u0627\u0644\u0646\u0628\u064A)/.test(name)
    ) {
      names.push(name);
      const afterQal = segment.split(/\u0642\u0627\u0644(?:\u0627)?/)[1] || '';
      const afterQalMeaningful = afterQal.replace(/[\s:\u060C,.\-]+/g, '');
      const continuesWithTransmission = new RegExp('^\\s*(?:[:\u060C,.-]\\s*)?' + ARABIC_TRANSMISSION_CUE_PATTERN).test(afterQal);
      if (names.length >= 2 && afterQalMeaningful && !continuesWithTransmission) break;
    }
  }

  const invalidNamePattern = /(?:\u0627\u0644\u0627\u0633\u0644\u0627\u0645|\u0627\u0644\u0627\u064A\u0645\u0627\u0646|\u0627\u0644\u0627\u062D\u0633\u0627\u0646|\u0627\u0644\u0633\u0627\u0639\u0629|\u0627\u0645\u0627\u0631\u062A\u0647\u0627|\u0628\u0627\u0639\u0644\u0645|\u064A\u0645\u064A\u0646\u0647)/;
  return names
    .filter((name, index, array) => name && !invalidNamePattern.test(name) && array.indexOf(name) === index)
    .slice(0, 20);
}

async function transliterateArabicNarratorChainWithGpt(arabicNames = []) {
  const names = Array.isArray(arabicNames) ? arabicNames.filter(Boolean) : [];
  if (names.length < 2) return 'Chain not available';

  try {
    const raw = await callOpenRouter([
      {
        role: 'system',
        content: 'Transliterate Arabic hadith narrator names into readable English. Return only names separated by ->. Do not add notes, labels, Arabic text, commentary, or explanations.'
      },
      {
        role: 'user',
        content: `Transliterate these Arabic hadith narrator names into readable English. Return only names separated by ->. Do not add notes.\n\n${names.join(' -> ')}`
      }
    ], { temperature: 0.0, max_tokens: 180 });

    return sanitizeNarratorChain(String(raw || '').replace(/```[\s\S]*?```/g, '').trim());
  } catch (err) {
    console.error('❌ Fallback narrator transliteration error:', err.message);
    return 'Chain not available';
  }
}

function resolveNarratorChain(parsedChain, arabicText = '') {
  return resolveNarratorChainResult(parsedChain, arabicText).chain;
}

function resolveNarratorChainResult(parsedChain, arabicText = '') {
  const sanitized = sanitizeNarratorChain(parsedChain);
  if (sanitized !== 'Chain not available') {
    return { chain: sanitized, chainSource: 'gpt' };
  }

  return { chain: 'Chain not available', chainSource: 'unavailable' };
}

async function resolveNarratorChainResultWithGptFallback(parsedChain, arabicText = '') {
  const primary = resolveNarratorChainResult(parsedChain, arabicText);
  if (primary.chain !== 'Chain not available') {
    return primary;
  }

  const arabicNames = extractArabicNarratorNamesFromArabic(arabicText);
  const fallback = await transliterateArabicNarratorChainWithGpt(arabicNames);
  if (fallback !== 'Chain not available') {
    return { chain: fallback, chainSource: 'fallback-gpt' };
  }

  return primary;
}

function logChainExtraction({ reference, arabicText, aiChain, finalChain }) {
  if (String(process.env.DEBUG_CHAIN_EXTRACTION || '').toLowerCase() !== 'true') return;
  console.log('[chain-debug]', {
    reference,
    arabicPreview: String(arabicText || '').slice(0, 300),
    aiChain: String(aiChain || '').slice(0, 300),
    finalChain
  });
}
function parseAiCommentary(raw = '') {
  const cleaned = String(raw || '').replace(/```[\s\S]*?```/g, '').trim();
  const commentaryHeading = '(?:Lessons\\s*&\\s*Benefits|Commentary|Explanation|Educational Commentary|Meaning)';
  const chainHeading = '(?:Chain of Narrators|Narrator Chain|Isnad|Chain)';
  const commentaryRegex = new RegExp(
    `${commentaryHeading}\\s*[:：-]?\\s*([\\s\\S]*?)(?=${chainHeading}\\s*[:：-]?|$)`,
    'i'
  );
  const chainRegex = new RegExp(`${chainHeading}\\s*[:：-]?\\s*([\\s\\S]*)`, 'i');

  const commentaryMatch = cleaned.match(commentaryRegex);
  const chainMatch = cleaned.match(chainRegex);
  const chain = sanitizeNarratorChain(chainMatch?.[1] || '');

  let commentary = commentaryMatch?.[1]?.trim() || '';
  if (!commentary) {
    // Preserve frontend compatibility even when the model omits headings.
    commentary = cleaned
      .replace(chainRegex, '')
      .replace(/(?:Evaluation of Hadith|Fiqh Ruling)\s*[:：-]?\s*[\s\S]*/i, '')
      .trim();
  }

  commentary = stripSectionHeading(commentary, commentaryHeading);

  return {
    commentary: commentary || 'Commentary was not available for this hadith. Please refer to qualified scholars for detailed explanation.',
    chain
  };
}

function needsWeakReportCaution(authenticityStatus = '') {
  return /\b(weak|not authentic|gharib|caution)\b/i.test(String(authenticityStatus));
}

function buildWeakReportCaution(authenticityStatus = '') {
  if (/not authentic/i.test(authenticityStatus)) {
    return 'This narration contains an explicit authenticity caution in the source text, so it should not be used by itself to establish a specific virtue, fixed reward, or religious practice.';
  }

  if (/gharib/i.test(authenticityStatus)) {
    return 'This narration contains an explicit gharib/caution note in the source text, so any specific virtue, fixed reward, or religious practice mentioned in it should be treated carefully unless verified through stronger evidence.';
  }

  return 'This narration contains a weak authenticity note in the source text, so it should not be used by itself to establish a specific virtue, fixed reward, or religious practice.';
}

function applyWeakReportCommentaryGuard(commentary = '', authenticityStatus = '') {
  if (!needsWeakReportCaution(authenticityStatus)) {
    return commentary;
  }

  const caution = buildWeakReportCaution(authenticityStatus);
  const cleaned = String(commentary || '')
    .replace(/\b(?:this\s+)?(?:hadith|narration|report)\s+serves\s+as\s+(?:a\s+)?motivation[^.]*\.\s*/gi, '')
    .replace(/\b(?:this\s+)?(?:hadith|narration|report)\s+(?:encourages|motivates)\s+[^.]*\.\s*/gi, '')
    .trim();

  if (cleaned.toLowerCase().startsWith(caution.toLowerCase())) {
    return cleaned;
  }

  const followUp = `${caution} A useful follow-up study is to research the source caution for this report and what stronger evidence exists on this topic.`;
  if (/(?:\*\*)?Further Study:(?:\*\*)?/i.test(cleaned)) {
    return cleaned.replace(/(?:\*\*)?Further Study:(?:\*\*)?\s*/i, `Further Study:\n\n${followUp} `);
  }

  return `${cleaned || 'Meaning:\n\nThe topic may still be discussed in a general educational way.\n\nKey Benefit:\n\nSpecific claims from this narration need stronger evidence before being used for practice.\n\nReflection:\n\nStudy the topic carefully with reliable references.\n\nMisunderstanding to Avoid:\n\nDo not treat this report alone as proof for a specific virtue or fixed reward.'}\n\nFurther Study:\n\n${followUp}`;
}

function polishCommentaryLanguage(commentary = '') {
  return formatLessonsAndBenefitsSpacing(String(commentary || '')
    .replace(/\*\*(Meaning|Key Benefit|Reflection|Misunderstanding to Avoid|Further Study):\*\*/gi, '$1:')
    .replace(/\bfor laymen\b/gi, 'for readers')
    .replace(/\bpractical benefit for readers\b/gi, 'practical benefit')
    .replace(/\bpractical benefit for the reader\b/gi, 'practical benefit')
    .trim());
}

function formatLessonsAndBenefitsSpacing(commentary = '') {
  const labels = [
    'Meaning',
    'Key Benefit',
    'Reflection',
    'Misunderstanding to Avoid',
    'Further Study'
  ];

  let formatted = String(commentary || '').replace(/\r\n/g, '\n');
  labels.forEach(label => {
    const pattern = new RegExp(`\\n*${label}:\\s*`, 'gi');
    formatted = formatted.replace(pattern, `\n\n${label}:\n\n`);
  });

  return formatted
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function removeUnneededFurtherStudy(commentary = '', authenticityStatus = '') {
  if (needsWeakReportCaution(authenticityStatus)) {
    return commentary;
  }

  return String(commentary || '')
    .replace(/\n*(?:\*\*)?Further Study:(?:\*\*)?[\s\S]*$/i, '')
    .replace(/\*\*(Meaning|Key Benefit|Reflection|Misunderstanding to Avoid|Further Study):\*\*/gi, '$1:')
    .trim();
}

// ─── Fuse.js Setup ─────────────────────────────────────────────────────────────
let fuse;
function initFuse() {
  if (USE_LIGHT_SEARCH) {
    fuse = null;
    fuseDataCache = [];
    console.log("Light search mode enabled; Fuse index skipped.");
    logMemoryUsage("after Fuse index creation");
    return;
  }

  // Keep the Fuse index compact: one combined search string, one reference string, and an index pointer.
  fuseDataCache = allHadithsCache.map((h, index) => {
    const en = getEnglishText(h);
    const ar = h.arabicText || "";
    const narrator = h.englishNarrator || "";
    const collectionTitle = h.collectionTitleEnglish || names[h.collection] || "";
    const chapterTitle = h.chapterTitleEnglish || h.bookName || "";
    const reference = getHadithReference(h);

    return {
      t: `${normalize(en)} ${normalize(ar)} ${normalize(narrator)} ${normalize(collectionTitle)} ${normalize(chapterTitle)}`,
      r: `${collectionTitle.toLowerCase()} ${String(reference || '').toLowerCase()} ${h.hadithNumber || h.idInBook || h.localHadithId || ""}`,
      i: index
    };
  });

  fuse = new Fuse(fuseDataCache, {
    includeScore: true,
    threshold: 0.35,
    minMatchCharLength: 4,
    ignoreLocation: true,
    keys: [
      { name: 't', weight: 0.8 },
      { name: 'r', weight: 0.2 }
    ]
  });
  logMemoryUsage("after Fuse index creation");
}

// ─── 5) SEARCH HELPER using Fuse.js ─────────────────────────────────────────────
function searchHadiths(query) {
  const q = normalize(query);
  const keywords = extractKeywords(query);

  if (!q || keywords.length === 0) return [];
  if (USE_LIGHT_SEARCH) return lightSearchHadiths(query, q, keywords);
  if (!fuse) return null;

  // Search quality order: exact phrase first, then all-keyword matches, then Fuse fuzzy fallback.
  const exactMatches = fuseDataCache.filter(item => item.t.includes(q) || item.r.includes(q)).map(item => allHadithsCache[item.i]);
  if (exactMatches.length) {
    return exactMatches.slice(0, 10);
  }

  const keywordMatches = allHadithsCache.filter(h => {
    const ar = normalize(h.arabicText || "");
    const en = normalize(getEnglishText(h));
    const extra = normalize([
      h.englishNarrator,
      h.reference,
      h.collectionTitleEnglish,
      h.chapterTitleEnglish,
      names[h.collection]
    ].filter(Boolean).join(' '));

    return keywords.every(keyword => ar.includes(keyword) || en.includes(keyword) || extra.includes(keyword));
  });

  if (keywordMatches.length) {
    return keywordMatches.slice(0, 10);
  }

  const results = fuse.search(q)
    .filter(r => r.score <= 0.35);

  return results.slice(0, 10).map(r => allHadithsCache[r.item.i]);
}

function insertTopScored(list, item, limit) {
  if (!item || item.score <= 0) return;

  let inserted = false;
  for (let i = 0; i < list.length; i += 1) {
    if (item.score > list[i].score) {
      list.splice(i, 0, item);
      inserted = true;
      break;
    }
  }

  if (!inserted && list.length < limit) {
    list.push(item);
  }

  if (list.length > limit) {
    list.length = limit;
  }
}

function getSearchFieldValues(h) {
  return [
    getHadithReference(h),
    h.collectionTitleEnglish || names[h.collection],
    h.chapterTitleEnglish,
    h.englishNarrator,
    h.arabicText,
    getEnglishText(h)
  ].filter(Boolean);
}

function normalizedFieldsInclude(fields, needle) {
  return fields.some(value => value.includes(needle));
}

function lightSearchHadiths(query, normalizedQuery, keywords) {
  const referenceMatch = findHadithByReferenceQuery(query);
  if (referenceMatch) return [referenceMatch];

  const scored = [];
  const rawQuery = String(query).trim().toLowerCase();
  for (const h of allHadithsCache) {
    const reference = String(getHadithReference(h) || '').toLowerCase();
    const fields = getSearchFieldValues(h).map(normalize);

    let score = 0;
    if (reference === rawQuery) score = 100;
    else if (reference.startsWith(rawQuery)) score = 90;
    else if (normalizedFieldsInclude(fields, normalizedQuery)) score = 70;
    else {
      let overlap = 0;
      for (const keyword of keywords) {
        if (normalizedFieldsInclude(fields, keyword)) overlap += 1;
      }
      if (overlap > 0) score = 40 + overlap;
    }

    insertTopScored(scored, { h, score }, 10);
  }

  return scored.map(item => item.h);
}

function findHadithByReferenceQuery(query) {
  const parsed = parseReferenceQuery(query);
  if (!parsed) return null;

  return findHadithByReference(`${parsed.collectionKey}:${parsed.referenceToken}`, parsed.collectionKey);
}

function formatHadithResult(h) {
    const en = getEnglishText(h);

    const ar  = h.arabicText || "[No Arabic]";
    const ref = getHadithReference(h);
    const authenticity = extractAuthenticityStatus(h, h.collection);
     // Mutawatir Check
const mutawatirInfo = checkMutawatir(ref);
const classification = mutawatirInfo
? `Classification: Mutawatir\nNotes: ${mutawatirInfo.notes}`
: `Classification: Ahad`;


    return `---\nArabic Matn: ${ar}\nEnglish Matn: ${en}\nReference: ${ref}\nAuthenticity Status: ${authenticity.status}\n${classification}`;
}

function serializeHadithResult(h) {
  const authenticity = extractAuthenticityStatus(h, h.collection);
  return {
    arabic: h.arabicText || '',
    english: getEnglishText(h),
    reference: getHadithReference(h),
    collection: h.collection || '',
    authenticityStatus: authenticity.status,
    authenticitySource: authenticity.source || '',
    sourceCaution: authenticity.caution || '',
    localId: h.localHadithId ?? h.id ?? null,
    idInBook: h.idInBook ?? null,
    sunnahReference: h.sunnahReference || h.canonicalRef || '',
    sunnahUrl: h.sunnahUrl || '',
    bookNumber: h.bookNumber ?? null,
    bookName: h.bookName || '',
    hadithInBook: h.hadithInBook || '',
    collectionTitleEnglish: h.collectionTitleEnglish || '',
    chapterTitleEnglish: h.chapterTitleEnglish || '',
    englishNarrator: h.englishNarrator || ''
  };
}

function buildSearchPayload(matches) {
  return {
    result: matches.map(formatHadithResult).join("\n"),
    results: matches.map(serializeHadithResult)
  };
}

function extractSuggestionPhrase(h, queryKeywords = []) {
  const english = normalize(getEnglishText(h));
  const arabic = normalizeArabicForDetection(h?.arabicText || '');
  const source = `${english} ${arabic}`.trim();
  const words = source.match(/[\p{L}\p{N}]+/gu) || [];

  if (!words.length) return '';

  const querySet = new Set(queryKeywords.map(normalize));
  const matchingIndex = words.findIndex(word => querySet.has(normalize(word)));
  const startIndex = matchingIndex === -1 ? 0 : matchingIndex;
  const phraseWords = words
    .slice(startIndex, startIndex + 5)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word.toLowerCase()));

  return phraseWords.slice(0, 5).join(' ').trim();
}

function buildDidYouMeanSuggestions(query) {
  const q = normalize(query);
  const keywords = extractKeywords(query);
  const suggestions = new Set();

  if (fuse) {
    fuse.search(q)
      .filter(r => r.score <= 0.6)
      .slice(0, 20)
      .forEach(r => {
        const phrase = extractSuggestionPhrase(allHadithsCache[r.item.i], keywords);
        if (phrase) suggestions.add(phrase);
      });
  }

  if (suggestions.size < 5 && keywords.length) {
    const topSuggestionCandidates = [];
    for (const h of allHadithsCache) {
      const fields = [getEnglishText(h), h.arabicText].filter(Boolean).map(normalize);
      let overlap = 0;
      for (const keyword of keywords) {
        if (normalizedFieldsInclude(fields, keyword)) overlap += 1;
      }
      insertTopScored(topSuggestionCandidates, { h, score: overlap }, 20);
    }

    topSuggestionCandidates.forEach(({ h }) => {
      const phrase = extractSuggestionPhrase(h, keywords);
      if (phrase) suggestions.add(phrase);
    });
  }

  return [...suggestions]
    .filter(suggestion =>
      suggestion.length >= 4 &&
      suggestion.toLowerCase() !== q &&
      !/\b(?:sahih|hasan|weak|authentic|fabricated|albani|hajar|graded|grading)\b/i.test(suggestion)
    )
    .slice(0, 5);
}

function formatDidYouMeanFallback(query, suggestions = []) {
  const cleanQuery = String(query || '').trim();
  const cleanSuggestions = suggestions
    .map(suggestion => String(suggestion || '').trim())
    .filter(Boolean)
    .slice(0, 5);
  const suggestionText = cleanSuggestions.length
    ? `\n\nDid you mean:\n${cleanSuggestions.map(suggestion => `• ${suggestion}`).join('\n')}`
    : '';

  return `---\nEnglish Matn:\nNo verified match found for "${cleanQuery}".${suggestionText}\n\n` +
    `Try exact Arabic or English wording for better results.\n\n` +
    `This result is not a hadith verification or grading.\n\n` +
    `Reference: Search Suggestions\n` +
    `Note: No local hadith result was matched.`;
}

// ─── 6) SEARCH ENDPOINT ───────────────────────────────────────────────────────
app.post("/search-hadith", async (req, res) => {
  const q = cleanInput(req.body.query, MAX_QUERY_LENGTH);
  if (!q) {
    return res.json({ result: 'âŒ No query provided.' });
  }

  logFirstSearchMemoryUsage();
  const referenceMatch = findHadithByReferenceQuery(q);
  if (referenceMatch) {
    return res.json(buildSearchPayload([referenceMatch]));
  }

  const matches = searchHadiths(q);

if (matches === null) {
  return res.json({
    result: '❌ Hadith database is still loading. Please try again in a few seconds.'
  });
}

  if (matches.length) {
    return res.json(buildSearchPayload(matches));
 } else {
  // Local-only fallback: suggest better search phrases without calling GPT or grading anything.
  const fallbackQuery = (req.body.query || '').trim();
  if (!fallbackQuery) {
    return res.json({ result: 'No query provided.' });
  }

  const safeFallbackResult = formatDidYouMeanFallback(
    fallbackQuery,
    buildDidYouMeanSuggestions(fallbackQuery)
  );

  return res.json({ result: safeFallbackResult });
 }
});
// ─── 8) COMMENTARY ENDPOINT ───────────────────────────────────────────────────
app.post('/gpt-commentary', async (req, res) => {
  const englishFull = cleanInput(req.body.english);
  const arabicFull  = cleanInput(req.body.arabic);
  const reference   = cleanInput(req.body.reference, 200);
  const collection  = cleanInput(req.body.collection, 40).toLowerCase();

  // Keep the evaluation key for older clients, but do not ask AI to grade hadith chains.
  const errorPayload = {
    commentary: 'No commentary.',
    chain: 'No chain.',
    evaluation: '',
    authenticityStatus: 'Not specified in source',
    authenticitySource: 'available source metadata/text',
    sourceCaution: ''
  };

  if (!englishFull || !arabicFull || !reference || !collection) {
    return res.json({
      commentary: 'Error: Missing required field.',
      chain: '',
      evaluation: '',
      authenticityStatus: 'Not specified in source',
      authenticitySource: 'available source metadata/text',
      sourceCaution: ''
    });
  }

  const cacheKey = `${COMMENTARY_CACHE_VERSION}|${reference}|${collection}`;
  const ip = getClientIp(req);
  const cachedCommentary = getCachedCommentary(cacheKey);
 if (cachedCommentary) {
  return res.json(cachedCommentary);
}

if (!checkAiLimit(ip)) {
  return res.json({
    commentary: 'Daily AI limit reached. Please try again after 24 hours.',
    chain: '',
    evaluation: '',
    authenticityStatus: 'Not specified in source',
    authenticitySource: 'available source metadata/text',
    sourceCaution: ''
  });
}
pruneAiCallTracker();
  const snippet = truncate(englishFull, 500);
  const sourceHadith = findHadithByReference(reference, collection);
  const authenticity = extractAuthenticityStatus(
    sourceHadith,
    collection || inferCollectionFromReference(reference),
    `${arabicFull} ${englishFull}`
  );
  const weakReportCaution = needsWeakReportCaution(authenticity.status)
    ? buildWeakReportCaution(authenticity.status)
    : '';
  const userPrompt =
    `Reference: ${reference}\n` +
    `Collection: ${collection}\n` +
    `Source Authenticity Status: ${authenticity.status}\n` +
    `Authenticity Source: ${authenticity.source}\n` +
    `Educational Caution: ${authenticity.caution || 'None'}\n` +
    `Weak Report Commentary Rule: ${weakReportCaution || 'None'}\n` +
    `Hadith (Arabic): ${arabicFull}\n` +
    `Hadith (English): ${snippet}`;

  const educationalSystemPrompt = `
You are a careful educational assistant for people studying hadith. Keep the explanation respectful, beginner friendly, balanced, and non-authoritative.

Output exactly these two sections in order and nothing else:

Lessons & Benefits:
Use exactly this plain-text format. Do not use Markdown, asterisks, bullets, or bold formatting:

Meaning: [1 to 2 short sentences]

Write the label on its own line, then a blank line, then the content.

Key Benefit: [1 to 2 short sentences]

Write the label on its own line, then a blank line, then the content.

Reflection: [1 to 2 short sentences]

Write the label on its own line, then a blank line, then the content.

Misunderstanding to Avoid: [1 short sentence]

Write the label on its own line, then a blank line, then the content.

Further Study: [Only include this label if the report is weak, cautioned, disputed, or not authentic. Do not include this section for sahih/authentic reports.]

If included, write the label on its own line, then a blank line, then the content.

Further Study rule:

Only include Further Study if:

* Weak Report Commentary Rule is not "None", OR
* Educational Caution is not "None", OR
* Source Authenticity Status indicates weak, daif, fabricated, mawdu, munkar, not authentic, disputed, or cautioned.

For sahih/authentic reports:

* Do not include Further Study.
* Do not mention why scholars weakened it.
* Do not mention weak grading.
* Do not say "why scholars differed or why the report was weakened."

For weak or cautioned reports:

* Keep the required weak report caution.
* Do not affirm the weak or cautioned claim as established.
* Do not encourage acting upon specific rewards, virtues, or claims based only on that narration.
* Explain that the user can study why scholars differed or why the report was weakened.
* Encourage further research with teachers and reliable hadith references.
* Do not independently grade the hadith.

Keep the total Lessons & Benefits section around 120 to 180 words.

Do not use the phrase "for laymen".

Do not issue fiqh verdicts, fatwa-style rulings, or independent hadith grading.

Do not present the explanation as authoritative.

Present the response as educational learning notes intended to help students reflect on and benefit from the hadith.

Chain of Narrators:
Extract narrator names from the Arabic isnad/matn and transliterate them into English, separated by ->.

Arabic isnad often begins with words such as حدثنا, أخبرنا, أنبأنا, قال, عن, سمعت, or ذكر. Use those transmission cues to identify the narrator sequence before the main matn.

Do not include commentary sentences, explanations, labels, grades, or notes.

Only write Chain not available if there is no identifiable Arabic isnad or narrator sequence.

If no identifiable isnad is available, write exactly:

Chain not available

Strict safety rules:

Do not include an Evaluation of Hadith section.

Do not include a Fiqh Ruling section.

Do not create an Authenticity Status section.

The Source Authenticity Status is reference context only and must not be changed, expanded, or independently assessed.

If unsure, keep the chain list simple with only names found in the Arabic text.
`.trim();

  try {
    let raw = await callOpenRouter([
      { role: 'system', content: educationalSystemPrompt },
      { role: 'user',   content: userPrompt }
    ], { temperature: 0.0, max_tokens: 700 });
    raw = raw.replace(/```[\s\S]*?```/g, '').trim();
    const parsedCommentary = parseAiCommentary(raw);
    const chainResult = await resolveNarratorChainResultWithGptFallback(parsedCommentary.chain, arabicFull);
    logChainExtraction({ reference, arabicText: arabicFull, aiChain: parsedCommentary.chain, finalChain: chainResult.chain });
    const guardedCommentary = polishCommentaryLanguage(applyWeakReportCommentaryGuard(
      removeUnneededFurtherStudy(parsedCommentary.commentary, authenticity.status),
      authenticity.status
    ));

    const payload = {
      commentary: guardedCommentary,
      chain: chainResult.chain,
      chainSource: chainResult.chainSource,
      evaluation: '',
      authenticityStatus: authenticity.status,
      authenticitySource: authenticity.source,
      sourceCaution: authenticity.caution
    };

    
    setCachedCommentary(cacheKey, payload);
    return res.json(payload);

  } catch (err) {
    console.error('❌ Commentary error:', err.response?.data || err.message);
    return res.json(errorPayload);
  }
});
// ─── 9) NARRATOR BIO ───────────────────────────────────────────────────────────
app.post('/narrator-bio', async (req, res) => {
  try {
    const name = cleanInput(req.body.name, 120);
    if (!name) {
      return res.json({ bio: 'No narrator name provided.' });
    }

    const ip = getClientIp(req);
    if (!checkAiLimit(ip)) {
      return res.json({ bio: 'Daily AI limit reached. Please try again after 24 hours.' });
    }
    pruneAiCallTracker();

    const educationalBioPrompt = `
You are an educational assistant helping users learn about hadith narrators and the history of hadith transmission.

The user will provide one narrator name.

Return a concise but informative plain-text biography using these labels exactly.

Do not use Markdown asterisks, bullet points, code fences, narrator grading discussions, authenticity rulings, or jarh wa ta'dil evaluations.

Write for beginners and students learning hadith history.

Focus on historical significance, contribution to hadith transmission, connection to major scholars or companions, and why the narrator is remembered.

If birth/death or interesting fact details are not known, write "Not clearly available." For other unknown details, keep the answer brief and avoid speculation.

Use this exact format:

Birth/Death:

[Birth and death dates or approximate period if known. If not known, write "Not clearly available."]

Place/Region:

[City, region, or scholarly center if known. If not known, write "Not clearly available."]

Teachers:

[Known teachers if known. If not known, write "Not clearly available."]

Students:

[Known students if known. If not known, write "Not clearly available."]


Interesting Fact:

[One memorable historical detail if widely known and reasonably reliable. If not known, write "Not clearly available."]

Important:
* Do not discuss whether the narrator is reliable or weak.
* Do not include jarh wa ta'dil grading.
* Do not say accepted or rejected reports.
* Do not invent dates, teachers, students, or facts.
* If birth/death is unknown, say "Not clearly available."
* Keep tone educational, warm, and non-authoritative.
* Target length: 100 to 180 words.
    `.trim();

    // 2) Send the narrator’s name as the user message
    const messages = [
      { role: 'system', content: educationalBioPrompt },
      { role: 'user',   content: name }
    ];

    const rawAi = await callOpenRouter(messages, { max_tokens: 800, temperature: 0.0 });

    // 3) Don’t strip bold markers—just remove code fences if they appear
    let raw = rawAi || '';
    raw = raw.replace(/```[\s\S]*?```/g, '').trim();
    raw = sanitizeNarratorBio(raw);

    return res.json({ bio: raw });
  } catch (err) {
    console.error('❌ Narrator bio error:', err.message);
    return res.json({ bio: 'Error fetching biography.' });
  }
});

// ─── 10) START SERVER ───────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    totalHadiths: allHadithsCache.length,
    fuseReady: !!fuse,
    searchMode: USE_LIGHT_SEARCH ? 'light' : 'fuse',
    commentaryCacheSize: commentaryCache.size,
    aiRateLimitTrackedIps: aiCallTracker.size,
    memory: process.memoryUsage(),
    collections: collectionCounts
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Takhrij backend running on port ${PORT}`));
}

module.exports = {
  app,
  extractAuthenticityStatus,
  normalizeArabicForDetection,
  sanitizeNarratorChain,
  extractNarratorChainFromArabic,
  formatDidYouMeanFallback
};
