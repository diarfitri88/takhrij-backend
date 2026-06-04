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

// ─── 0) CACHE FOR COMMENTARY ───────────────────────────────────────────────────
const commentaryCache = new Map();
const MAX_COMMENTARY_CACHE_ENTRIES = 250;
const COMMENTARY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COMMENTARY_CACHE_VERSION = 'lessons-benefits-v1';

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
let bukhariHadiths = [], muslimHadiths = [], tirmidhiHadiths = [], nasaiHadiths = [];
let malikHadiths = [], ibnMajahHadiths = [], darimiHadiths = [], ahmedHadiths = [], abuDawudHadiths = [];
let localExtraHadiths = [];
// Keep combined search data cached after startup; rebuilding it per request is costly for large JSON collections.
let allHadithsCache = [];
let fuseDataCache = [];

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
    const english = hadith.english && typeof hadith.english === 'object' ? hadith.english : {};
    const hadithNumber = hadith.idInBook;
    const englishNarrator = english.narrator || '';
    const englishText = english.text || '';
    const arabicText = hadith.arabic || '';
    const reference = `${collectionTitleEnglish} ${hadithNumber}`;

    return {
      collection: collectionId,
      collectionId,
      collectionTitleArabic,
      collectionTitleEnglish,
      collectionAuthorArabic,
      collectionAuthorEnglish,
      localHadithId: hadith.id,
      id: hadith.id,
      hadithNumber,
      idInBook: hadithNumber,
      bookId: hadith.bookId,
      chapterId: hadith.chapterId,
      chapterTitleArabic: chapter.arabic || '',
      chapterTitleEnglish: chapter.english || '',
      arabicText,
      arabic: arabicText,
      englishNarrator,
      englishText,
      english: {
        narrator: englishNarrator,
        text: englishText
      },
      reference,
      sourceFile
    };
  });
}

function loadLocalExtraHadiths() {
  const loaded = [];

  Object.entries(localExtraHadithFiles).forEach(([collectionId, filePath]) => {
    const sourceFile = path.basename(filePath);
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const normalized = normalizeLocalExtraHadith(collectionId, sourceFile, payload);
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
    const results = await Promise.all(collections.map(collection => loadCollectionRows(collection)));
    results.forEach((arr, i) => {
      const mapped = arr.map(h => ({ ...h, collection: collections[i] }));
      switch (collections[i]) {
        case "bukhari":  bukhariHadiths  = mapped; break;
        case "muslim":   muslimHadiths   = mapped; break;
        case "tirmidhi": tirmidhiHadiths = mapped; break;
        case "nasai":    nasaiHadiths    = mapped; break;
        case "malik":    malikHadiths    = mapped; break;
        case "ibnmajah": ibnMajahHadiths = mapped; break;
        case "darimi":   darimiHadiths   = mapped; break;
        case "ahmed":    ahmedHadiths    = mapped; break;
        case "abudawud": abuDawudHadiths = mapped; break;
      }
    });
    console.log("✅ All hadith collections loaded.");
    localExtraHadiths = loadLocalExtraHadiths();
    allHadithsCache = getAllHadiths();
    console.log(`Total combined hadith loaded: ${allHadithsCache.length}`);
    // After loading hadiths, initialize Fuse.js with all hadiths combined:
    initFuse();
  } catch (err) {
    console.error("❌ Failed to load hadiths:", err.message);
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

function getAllHadiths() {
  return [
    ...bukhariHadiths, ...muslimHadiths, ...tirmidhiHadiths,
    ...nasaiHadiths, ...malikHadiths, ...ibnMajahHadiths,
    ...darimiHadiths, ...ahmedHadiths, ...abuDawudHadiths,
    ...localExtraHadiths
  ];
}

function getEnglishText(h) {
  if (typeof h.english === "string") return h.english;
  if (h.english && typeof h.english === "object") return h.english.text || h.english.body || "";
  if (typeof h.englishText === "string") return h.englishText;
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
    const hadithNumbers = [h.hadithnumber, h.idInBook, h.id, h.number]
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

  const sourceText = `${explicitFields} ${getEnglishText(h || {})} ${h?.arabic || ''} ${sourceOverride}`;
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
    'era/generation',
    'place/region',
    'region',
    'teachers',
    'students',
    'collections',
    'known for',
    'role in hadith transmission',
    'educational note',
    'connection to the prophetic era',
    'historical significance',
    'interesting fact',
    'educational importance'
  ];
  const sectionValues = new Map();
  let currentLabel = null;

  String(rawBio)
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .forEach(line => {
      const labelMatch = line.match(/^\*\*([^:*]+):\*\*/);
      if (labelMatch) {
        const label = labelMatch[1].trim().toLowerCase();
        currentLabel = allowedLabels.includes(label) ? label : null;

        if (currentLabel) {
          const value = line.replace(/^\*\*[^:*]+:\*\*\s*/, '').trim();
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

  const isPlaceholder = value => /^(not listed|not specified|unknown|unclear|n\/a|none)\b/i.test(String(value).trim());
  const preferredKnownFor = sectionValues.get('known for') || sectionValues.get('educational importance');
  const safeSections = [
    ['Era/Generation', sectionValues.get('era/generation')],
    ['Place/Region', sectionValues.get('place/region') || sectionValues.get('region')],
    ['Known For', preferredKnownFor],
    ['Connection to the Prophetic Era', sectionValues.get('connection to the prophetic era')],
    ['Role in Hadith Transmission', sectionValues.get('role in hadith transmission')],
    ['Teachers', sectionValues.get('teachers')],
    ['Students', sectionValues.get('students')],
    ['Collections', sectionValues.get('collections')],
    ['Historical Significance', sectionValues.get('historical significance')],
    ['Interesting Fact', sectionValues.get('interesting fact')],
    ['Educational Note', sectionValues.get('educational note')]
  ].filter(([, value]) => value && !isPlaceholder(value));

  if (!safeSections.length) {
    return '**Educational Note:** Beginner-level historical information for this narrator is not available in this brief summary.';
  }

  return safeSections
    .map(([label, value]) => `**${label}:** ${value}`)
    .join('\n');
}

function stripSectionHeading(text = '', headingPattern) {
  return String(text)
    .replace(new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?${headingPattern}(?:\\*\\*)?\\s*[:：-]?\\s*`, 'i'), '')
    .trim();
}

function sanitizeNarratorChain(chain = '') {
  const cleaned = String(chain || '')
    .replace(/\*\*/g, '')
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)[0]
    .split(/(?:Lessons\s*&\s*Benefits|Commentary|Explanation|Educational Commentary|Meaning|Evaluation of Hadith|Fiqh Ruling)\s*[:ï¼š-]?/i)[0]
    .trim();

  if (!cleaned || /^no chain\.?$/i.test(cleaned) || /^chain not available\.?$/i.test(cleaned)) {
    return 'Chain not available';
  }

  const hasChainDelimiter = /(?:->|â†’|=>|,|;|،)/.test(cleaned);
  if (!hasChainDelimiter) {
    return 'Chain not available';
  }

  const sentencePattern = /[.!?]|\b(?:hadith|narration|report|meaning|lesson|benefit|reader|practice|authenticity|source|reward|virtue|specific|claim)\b/i;
  const names = cleaned
    .split(/\s*(?:->|â†’|=>|,|;|،)\s*/)
    .map(name => name.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean);

  if (
    names.length < 2 ||
    names.length > 20 ||
    names.some(name => name.length > 55 || sentencePattern.test(name) || /\s{2,}/.test(name))
  ) {
    return 'Chain not available';
  }

  return names.join(' -> ');
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

  return `${caution}\n\n${cleaned || 'The topic may still be discussed in a general educational way, but specific claims from this narration need stronger evidence before being used for practice.'}`;
}

function polishCommentaryLanguage(commentary = '') {
  return String(commentary || '')
    .replace(/\bfor laymen\b/gi, 'for readers')
    .replace(/\bpractical benefit for readers\b/gi, 'practical benefit')
    .replace(/\bpractical benefit for the reader\b/gi, 'practical benefit')
    .trim();
}

// ─── Fuse.js Setup ─────────────────────────────────────────────────────────────
let fuse;
function initFuse() {
  // Prepare data for Fuse search - we keep the full hadith object as 'hadith'
  fuseDataCache = allHadithsCache.map(h => {
    const en = getEnglishText(h);
    const ar = h.arabicText || h.arabic || "";
    const narrator = h.englishNarrator || h.english?.narrator || "";
    const collectionTitle = h.collectionTitleEnglish || names[h.collection] || "";
    const chapterTitle = h.chapterTitleEnglish || h.bookName || "";
    const reference = getHadithReference(h);

    return {
      text: `${normalize(en)} ${normalize(ar)} ${normalize(narrator)} ${normalize(collectionTitle)} ${normalize(chapterTitle)} ${normalize(reference)}`,
      arabicText: normalize(ar),
      englishText: normalize(en),
      englishNarrator: normalize(narrator),
      referenceText: `${collectionTitle.toLowerCase()} ${String(reference || '').toLowerCase()} ${h.hadithnumber || h.hadithNumber || h.idInBook || h.id || h.number || ""}`,
      collectionTitleEnglish: normalize(collectionTitle),
      chapterTitleEnglish: normalize(chapterTitle),
      hadith: h
    };
  });

  fuse = new Fuse(fuseDataCache, {
    includeScore: true,
    threshold: 0.35,
    minMatchCharLength: 4,
    ignoreLocation: true,
    keys: [
      { name: 'text', weight: 0.45 },
      { name: 'arabicText', weight: 0.2 },
      { name: 'englishText', weight: 0.2 },
      { name: 'englishNarrator', weight: 0.05 },
      { name: 'referenceText', weight: 0.05 },
      { name: 'collectionTitleEnglish', weight: 0.03 },
      { name: 'chapterTitleEnglish', weight: 0.02 }
    ]
  });
}

// ─── 5) SEARCH HELPER using Fuse.js ─────────────────────────────────────────────
function searchHadiths(query) {
  const q = normalize(query);
  const keywords = extractKeywords(query);

  if (!q || keywords.length === 0) return [];
  if (!fuse) return null;

  // Search quality order: exact phrase first, then all-keyword matches, then Fuse fuzzy fallback.
  const exactMatches = fuseDataCache.filter(({ text }) => text.includes(q)).map(({ hadith }) => hadith);
  if (exactMatches.length) {
    return exactMatches.slice(0, 10);
  }

  const keywordMatches = allHadithsCache.filter(h => {
    const ar = normalize(h.arabicText || h.arabic || "");
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

  return results.slice(0, 10).map(r => r.item.hadith);
}

function findHadithByReferenceQuery(query) {
  const parsed = parseReferenceQuery(query);
  if (!parsed) return null;

  return findHadithByReference(`${parsed.collectionKey}:${parsed.referenceToken}`, parsed.collectionKey);
}

function formatHadithResult(h) {
    const en = getEnglishText(h);

    const ar  = h.arabicText || h.arabic || "[No Arabic]";
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
    arabic: h.arabic || '',
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
  const arabic = normalizeArabicForDetection(h?.arabic || '');
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
  if (!fuse) return [];

  const q = normalize(query);
  const keywords = extractKeywords(query);
  const suggestions = new Set();

  fuse.search(q)
    .filter(r => r.score <= 0.6)
    .slice(0, 20)
    .forEach(r => {
      const phrase = extractSuggestionPhrase(r.item.hadith, keywords);
      if (phrase) suggestions.add(phrase);
    });

  if (suggestions.size < 5 && keywords.length) {
    allHadithsCache
      .map(h => {
        const text = `${normalize(getEnglishText(h))} ${normalize(h.arabic || '')}`;
        const overlap = keywords.filter(keyword => text.includes(keyword)).length;
        return { h, overlap };
      })
      .filter(item => item.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 20)
      .forEach(({ h }) => {
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
Give a comprehensive but concise educational explanation.

If Weak Report Commentary Rule is not "None", start with that exact caution and do not encourage practice, specific rewards, or virtues based on this narration. For weak or cautioned reports, discuss the topic generally and clearly state that specific claims need stronger evidence.

If Educational Caution is not "None", include it in beginner-friendly wording.

Cover:

* The meaning of the hadith
* Relevant context or background where appropriate
* Key lessons and benefits
* Practical applications in daily life
* Good manners, character, worship, or beliefs that are clearly supported by the hadith
* One common misunderstanding to avoid
* A natural practical takeaway using wording such as:
  "A practical benefit is"
  "This can help the reader"
  "One takeaway is"
  "In daily practice"

Do not use the phrase "for laymen".

Do not issue fiqh verdicts, fatwa-style rulings, or independent hadith grading.

Do not present the explanation as authoritative.

Present the response as educational learning notes intended to help students reflect on and benefit from the hadith.

Chain of Narrators:
Extract only narrator names from the Arabic isnad and transliterate into English, separated by ->.

Do not include commentary sentences, explanations, labels, grades, or notes.

If a clean narrator-name chain is not available, write exactly:

Chain not available

Strict safety rules:

Do not include an Evaluation of Hadith section.

Do not include a Fiqh Ruling section.

Do not create an Authenticity Status section.

The Source Authenticity Status is reference context only and must not be changed, expanded, or independently assessed.

If unsure, keep the chain list simple and say "Chain not available."
`.trim();

  try {
    let raw = await callOpenRouter([
      { role: 'system', content: educationalSystemPrompt },
      { role: 'user',   content: userPrompt }
    ], { temperature: 0.0, max_tokens: 700 });
    raw = raw.replace(/```[\s\S]*?```/g, '').trim();
    const parsedCommentary = parseAiCommentary(raw);
    const guardedCommentary = polishCommentaryLanguage(applyWeakReportCommentaryGuard(
      parsedCommentary.commentary,
      authenticity.status
    ));

    const payload = {
      commentary: guardedCommentary,
      chain: parsedCommentary.chain,
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

Return a concise but informative Markdown biography using **bold labels only**.

Do not use bullet points, code fences, narrator grading discussions, authenticity rulings, or jarh wa ta'dil evaluations.

Write for beginners and students learning hadith history.

Focus on historical significance, contribution to hadith transmission, connection to major scholars or companions, and why the narrator is remembered.

If a detail is not known, omit it rather than speculate.

Use this exact format:

**Era/Generation:** [Sahabi, Tabi'i, Tabi' al-Tabi'in, later scholar, or unclear]

**Place/Region:** [City, region, or scholarly center if known]

**Known For:** [1-3 informative sentences explaining who this person was and why they are remembered]

**Connection to the Prophetic Era:** [Explain the narrator's connection to the Prophet ﷺ, Companions, or early generations if known]

**Role in Hadith Transmission:** [Explain how this narrator contributed to preserving, teaching, transmitting, collecting, or spreading hadith]

**Teachers:** [Known teachers if known]

**Students:** [Known students if known]

**Collections:** [Major hadith collections where this narrator appears when known]

**Historical Significance:** [1-3 sentences explaining why students of hadith continue to encounter this narrator and why this narrator matters in the history of hadith preservation]

**Interesting Fact:** [A memorable historical detail if widely known and reasonably reliable]

Important:

* Do not discuss whether the narrator is reliable or weak.
* Do not include jarh wa ta'dil grading.
* Do not say "accepted" or "rejected" reports.
* Do not invent dates, teachers, students, or facts.
* If a section is not known, keep it brief or write "Not clearly available."
* Keep the tone educational, warm, and non-authoritative.
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
    commentaryCacheSize: commentaryCache.size,
    aiRateLimitTrackedIps: aiCallTracker.size,
    collections: {
      bukhari: bukhariHadiths.length,
      muslim: muslimHadiths.length,
      tirmidhi: tirmidhiHadiths.length,
      nasai: nasaiHadiths.length,
      malik: malikHadiths.length,
      ibnmajah: ibnMajahHadiths.length,
      darimi: darimiHadiths.length,
      ahmed: ahmedHadiths.length,
      abudawud: abuDawudHadiths.length
    }
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
  formatDidYouMeanFallback
};
