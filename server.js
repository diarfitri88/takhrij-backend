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

// ─── RATE LIMITING (Rolling 24-hour limit per IP) ───────────────────────────────
const aiCallTracker = new Map(); // { 'IP': { count: x, lastReset: timestamp } }

const MAX_CALLS = 15;
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

async function loadHadiths() {
  try {
    const collections = Object.keys(urls);
    const results = await Promise.all(collections.map(collection => axios.get(urls[collection], { timeout: 20000 })));
    results.forEach((res, i) => {
      const arr = Array.isArray(res.data) ? res.data : (Array.isArray(res.data.hadiths) ? res.data.hadiths : []);
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
    allHadithsCache = getAllHadiths();
    // After loading hadiths, initialize Fuse.js with all hadiths combined:
    initFuse();
  } catch (err) {
    console.error("❌ Failed to load hadiths:", err.message);
  }
}
loadHadiths();

const names = {
  bukhari:   "Sahih Bukhari",
  muslim:    "Sahih Muslim",
  tirmidhi:  "Jami` at-Tirmidhi",
  nasai:     "Sunan an-Nasa'i",
  malik:     "Muwatta Malik",
  ibnmajah:  "Sunan Ibn Majah",
  darimi:    "Sunan ad-Darimi",
  ahmed:     "Musnad Ahmad",
  abudawud:  "Sunan Abu Dawood"
};

const refFormatters = {
  default: h => `${names[h.collection] || "Unknown"} ${h.hadithnumber || h.id || h.number}`
};

function getAllHadiths() {
  return [
    ...bukhariHadiths, ...muslimHadiths, ...tirmidhiHadiths,
    ...nasaiHadiths, ...malikHadiths, ...ibnMajahHadiths,
    ...darimiHadiths, ...ahmedHadiths, ...abuDawudHadiths
  ];
}

function getEnglishText(h) {
  if (typeof h.english === "string") return h.english;
  if (h.english && typeof h.english === "object") return h.english.text || h.english.body || "";
  if (typeof h.text === "string") return h.text;
  if (typeof h.body === "string") return h.body;
  return "";
}

function getHadithReference(h) {
  return h.reference
    ? h.reference
    : (refFormatters[h.collection] || refFormatters.default)(h);
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
    nasai: 'nasai',
    sunannasai: 'nasai',
    malik: 'malik',
    muwattamalik: 'malik',
    ibnmajah: 'ibnmajah',
    sunanibnmajah: 'ibnmajah',
    darimi: 'darimi',
    sunandarimi: 'darimi',
    ahmed: 'ahmed',
    ahmad: 'ahmed',
    musnadahmad: 'ahmed',
    abudawud: 'abudawud',
    abidawud: 'abudawud',
    sunanabidawud: 'abudawud'
  };

  return aliases[input] || value;
}

function inferCollectionFromReference(reference = '') {
  const normalized = String(reference).toLowerCase();
  if (normalized.includes('bukhari')) return 'bukhari';
  if (normalized.includes('muslim')) return 'muslim';
  return '';
}

function findHadithByReference(reference, collection) {
  const collectionKey = normalizeCollectionKey(collection || inferCollectionFromReference(reference));
  const referenceText = String(reference || '').toLowerCase();
  const referenceNumber = (referenceText.match(/\d+/g) || []).pop();

  return allHadithsCache.find(h => {
    if (collectionKey && h.collection !== collectionKey) return false;

    const knownReference = getHadithReference(h).toLowerCase();
    if (knownReference === referenceText) return true;

    const hadithNumbers = [h.hadithnumber, h.idInBook, h.id, h.number]
      .filter(Boolean)
      .map(value => String(value));

    return referenceNumber && hadithNumbers.includes(referenceNumber);
  }) || null;
}

function extractAuthenticityStatus(h, collection) {
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

  const sourceText = `${explicitFields} ${getEnglishText(h || {})} ${h?.arabic || ''}`;
  const source = explicitFields ? 'structured source field' : 'explicit source text';
  const hasExplicitWeakPhrase =
    /\b(?:da['‘’]?if|daeef|weak)\b/i.test(explicitFields) ||
    /\b(?:graded|classed|classified|declared|marked|ruled)\s+(?:as\s+)?(?:da['‘’]?if|daeef|weak)\b/i.test(sourceText) ||
    /\b(?:da['‘’]?if|daeef|weak)\s*\)/i.test(sourceText) ||
    /ه[ٰذ]ا\s+حديث\s+ضعيف/.test(sourceText) ||
    /ضعفه\s+الألباني/.test(sourceText) ||
    /لا\s+يصح/.test(sourceText);
  const hasExplicitHasanSahihPhrase =
    /\b(?:graded|classed|classified|declared|marked|ruled)\s+(?:as\s+)?hasan\s+sahih\b/i.test(sourceText) ||
    /\bhasan\s+sahih\b/i.test(explicitFields) ||
    /حسن\s+صحيح/.test(sourceText);
  const hasExplicitSahihPhrase =
    /\b(?:graded|classed|classified|declared|marked|ruled)\s+(?:as\s+)?sahih\b/i.test(sourceText) ||
    /\bsahih\s*\)/i.test(sourceText) ||
    /\bsahih\b/i.test(explicitFields) ||
    /صححه\s+الألباني/.test(sourceText) ||
    /ه[ٰذ]ا\s+حديث\s+صحيح/.test(sourceText);
  const hasExplicitHasanPhrase =
    /\b(?:graded|classed|classified|declared|marked|ruled)\s+(?:as\s+)?hasan\b/i.test(sourceText) ||
    /\bhasan\s*\)/i.test(sourceText) ||
    /\bhasan\b/i.test(explicitFields) ||
    /ه[ٰذ]ا\s+حديث\s+حسن/.test(sourceText);

  // This only surfaces explicit grading phrases already present in local/source data; GPT is not asked to grade.
  if (hasExplicitWeakPhrase) {
    return {
      status: "Weak (mentioned in source text)",
      source,
      caution: 'This source text includes an explicit weakness note. Treat the commentary as educational background only and verify religious use with qualified scholars.'
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
    'teachers',
    'students',
    'collections',
    'known for',
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

  const preferredKnownFor = sectionValues.get('known for') || sectionValues.get('educational importance');
  const safeSections = [
    ['Era/Generation', sectionValues.get('era/generation') || 'Not specified in this summary'],
    ['Teachers', sectionValues.get('teachers') || 'Not listed in this summary'],
    ['Students', sectionValues.get('students') || 'Not listed in this summary'],
    ['Collections', sectionValues.get('collections') || 'Not specified in this summary'],
    ['Known For', preferredKnownFor || 'Educational role not specified in this summary']
  ];

  return safeSections
    .map(([label, value]) => `**${label}:** ${value}`)
    .join('\n');
}

// ─── Fuse.js Setup ─────────────────────────────────────────────────────────────
let fuse;
function initFuse() {
  // Prepare data for Fuse search - we keep the full hadith object as 'hadith'
  fuseDataCache = allHadithsCache.map(h => {
    const en = getEnglishText(h);
    const ar = h.arabic || "";

    return {
      text: `${normalize(en)} ${normalize(ar)}`,
      referenceText: `${(names[h.collection] || "").toLowerCase()} ${h.reference || ""} ${h.hadithnumber || h.id || h.number || ""}`,
      hadith: h
    };
  });

  fuse = new Fuse(fuseDataCache, {
    includeScore: true,
    threshold: 0.35,
    minMatchCharLength: 4,
    ignoreLocation: true,
    keys: [
      { name: 'text', weight: 0.85 },
      { name: 'referenceText', weight: 0.15 }
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
    const ar = normalize(h.arabic || "");
    const en = normalize(getEnglishText(h));

    return keywords.every(keyword => ar.includes(keyword) || en.includes(keyword));
  });

  if (keywordMatches.length) {
    return keywordMatches.slice(0, 10);
  }

  const results = fuse.search(q)
    .filter(r => r.score <= 0.35);

  return results.slice(0, 10).map(r => r.item.hadith);
}

// ─── 6) SEARCH ENDPOINT ───────────────────────────────────────────────────────
app.post("/search-hadith", async (req, res) => {
  const q = cleanInput(req.body.query, MAX_QUERY_LENGTH);
  if (!q) {
    return res.json({ result: 'âŒ No query provided.' });
  }

  const matches = searchHadiths(q);

if (matches === null) {
  return res.json({
    result: '❌ Hadith database is still loading. Please try again in a few seconds.'
  });
}

  if (matches.length) {
    const result = matches.map(h => {
      const en = getEnglishText(h);

      const ar  = h.arabic || "[No Arabic]";
      const ref = getHadithReference(h);
      const authenticity = extractAuthenticityStatus(h, h.collection);
       // Mutawatir Check
  const mutawatirInfo = checkMutawatir(ref);
  const classification = mutawatirInfo
  ? `Classification: Mutawatir\nNotes: ${mutawatirInfo.notes}`
  : `Classification: Ahad`;


      return `---\nArabic Matn: ${ar}\nEnglish Matn: ${en}\nReference: ${ref}\nAuthenticity Status: ${authenticity.status}\n${classification}`;
    }).join("\n");
    return res.json({ result });
 } else {
// ─── GPT FALLBACK ─────────────────────────────────────────────────────────
  try {
   const q = (req.body.query || '').trim();
if (!q) {
  return res.json({ result: '❌ No query provided.' });
}   
    const ip = getClientIp(req);
    if (!checkAiLimit(ip)) {
      return res.json({ result: 'Daily AI limit reached. Please try again after 24 hours.' });
    }
    pruneAiCallTracker();

    const prompt = `
You are a hadith researcher trained on the Salafi methodology, including the works of Ibn Taymiyyah, Ibn al-Qayyim, Al-Albani, Ibn Baz, and Ibn Hajar.

The user submitted a phrase from a hadith, in Arabic or English, which may be misquoted, vague, or incorrectly attributed.

You must respond in **exactly 4 paragraphs**, each under **80 words** and separated by **two real line breaks** (\\n\\n). Do **not combine points** in one paragraph.

If the phrase is verifiable in the 9 primary hadith collections (Bukhari, Muslim, Abu Dawood, Tirmidhi, Ibn Majah, Nasa’i, Ahmad, Muwatta, Darimi), give the **exact matn**, **grading**, and **reference**. Cite scholars like Al-Albani or Ibn Hajar. Do **not use general language like “reported in various sources”**. Only cite what is verified.

If the phrase is vague, unclear, or a standalone Arabic word (e.g., لأواء, عيلة), define it based on hadith or rijāl usage only. Do **not translate based on modern Arabic or personal guesswork**.

Then suggest one sahih hadith with a **similar theme**. Only include it if it is **found in the 9 books** and graded **sahih** by Salafi scholars. Do **not cite weak or disputed hadiths**. Avoid “city of knowledge” and other unreliable narrations.

Finally, suggest 3–5 **matn-style keywords** from known sahih hadiths (e.g., “smiling is charity”, “fear Allah”, “whoever lies about me”). Do not use poetic or vague expressions.

Strict rules:
- Use “Prophet Muhammad ﷺ” with salutation.
- No Qur’an quotes.
- No combining points.
- No guessing, no metaphorical claims, no vague mentions.
- Do not say “may be interpreted as”, “it might be”, or “reported elsewhere”.
- No apologies or suggestions like “try rephrasing”.

Stick to classical hadith sources only. Respond like a precise Salafi muhaqqiq.
`.trim();

    const rawAi = await callOpenRouter([
      { role: "system", content: prompt },
      { role: "user", content: q }
    ], { max_tokens: 1200, temperature: 0.0 });

let raw = rawAi || '';
    
raw = raw.replace(/\r\n/g, '\n');
raw = raw.replace(/\n{3,}/g, '\n\n');
raw = raw.replace(/(?<=[a-z0-9])\. (?=[A-Z])/g, '.\n\n'); // keep
raw = raw.replace(/\n{2,}/g, '\n\n');                    // normalize spacing
raw = raw.replace(/([^\n])\n([^\n])/g, '$1 $2');          // fix mid-sentence breaks
raw = raw.trim();
    
    const result =
    `---\nEnglish Matn:\n${raw}\n\n` +
    `Reference: AI Generated\n` +
    `Note: No close match was found in the local JSON search. The AI response is only a fallback and should be verified against source texts.\n` +
    `Search tip: Enter specific keywords (minimum 3 letters each) separated by spaces; common words like "and", "the", "of" are ignored, and fuzzy matching helps catch close spellings.`;


   return res.json({ result });
    } catch (err) {
      console.error("❌ GPT fallback error:", err.message);
      return res.json({ result: `❌ AI fallback failed. Please try again later.` });
    }
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

  const cacheKey = `${reference}|${collection}`;
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
  const authenticity = extractAuthenticityStatus(sourceHadith, collection || inferCollectionFromReference(reference));
  const userPrompt =
    `Reference: ${reference}\n` +
    `Collection: ${collection}\n` +
    `Source Authenticity Status: ${authenticity.status}\n` +
    `Authenticity Source: ${authenticity.source}\n` +
    `Educational Caution: ${authenticity.caution || 'None'}\n` +
    `Hadith (Arabic): ${arabicFull}\n` +
    `Hadith (English): ${snippet}`;

  const educationalSystemPrompt =
    `You are a careful educational assistant for laymen studying hadith. Keep the explanation respectful, beginner friendly, and non-authoritative.\n` +
    `Output exactly these two sections in order and nothing else:\n` +
    `Commentary: Give a comprehensive but concise educational explanation. If Educational Caution is not "None", begin with that caution in one short sentence. Cover the meaning of the hadith, context or background where appropriate, key lessons, one common misunderstanding to avoid, and practical benefit for laymen. Do not issue fiqh verdicts, fatwa-style rulings, or independent hadith grading. Do not present the explanation as authoritative.\n` +
    `Chain of Narrators: extract narrator names from the Arabic text and transliterate into English, separated by ->. Do not evaluate, grade, praise, weaken, authenticate, or criticize the chain or narrators.\n` +
    `Strict safety rules: Do not include an Evaluation of Hadith section. Do not include a Fiqh Ruling section. Do not create an Authenticity Status section. The Source Authenticity Status is reference context only and must not be changed, expanded, or independently assessed. If unsure, keep the chain list simple and say "No chain."`;

  try {
    let raw = await callOpenRouter([
      { role: 'system', content: educationalSystemPrompt },
      { role: 'user',   content: userPrompt }
    ], { temperature: 0.0, max_tokens: 700 });
    raw = raw.replace(/```[\s\S]*?```/g, '').trim();

    // Parse only educational commentary and narrator-chain text; grading/fiqh sections are intentionally ignored.
    const commentaryMatch = raw.match(/Commentary[^:]*:\s*([\s\S]*?)(?=Chain of Narrators[^:]*:)/i);
    const chainMatch      = raw.match(/Chain of Narrators[^:]*:\s*([\s\S]*)/i);

    const payload = {
      commentary: commentaryMatch && commentaryMatch[1].trim() ? commentaryMatch[1].trim() : 'No commentary.',
      chain:      chainMatch && chainMatch[1].trim() ? chainMatch[1].trim() : 'No chain.',
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

    const educationalBioPrompt = `
You are an educational assistant helping laymen learn basic hadith narrator context.

The user will give one narrator name. Return a concise Markdown summary using **bold labels only** and no bullet points, code fences, scholar evaluation commentary, or narrator authenticity discussion.

Keep the biography simple and educational. Focus only on historical role, importance in hadith transmission, connection to major scholars or companions, and educational significance. Do not evaluate whether the narrator's reports are accepted or rejected.

If the narrator is unclear or too ambiguous, fill the fields below with "Not specified in this summary".

Use this exact format:

**Era/Generation:** [Sahabi, Tabi'i, Tabi' al-Tabi'in, later scholar, or unclear]
**Teachers:** [Known teachers, or "Not listed in this summary"]
**Students:** [Known students, or "Not listed in this summary"]
**Collections:** [Major hadith collections where this narrator appears when known, or "Not specified in this summary"]
**Known For:** [2-3 beginner-friendly sentences about historical role, hadith transmission, Islamic learning, and educational significance]
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
app.listen(PORT, () => console.log(`Takhrij backend running on port ${PORT}`));
