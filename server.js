// File: server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const Fuse = require("fuse.js");

const app = express();

app.use(cors());
app.use(express.json());

// ─── 0) CACHE FOR COMMENTARY ───────────────────────────────────────────────────
const commentaryCache = {};

// ─── 1) HELPER: Truncate long text to 500 chars ───────────────────────────────
function truncate(text, max = 500) {
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
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ─── 3) HELPER: normalize text for searching ────────────────────────────────────
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u065F]/g, '')       // remove Arabic diacritics
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '') // strip punctuation
    .replace(/\s{2,}/g, ' ')               // collapse multiple spaces
    .trim();
}

// ─── 4) LOAD HADITH COLLECTIONS ────────────────────────────────────────────────
let bukhariHadiths = [], muslimHadiths = [], tirmidhiHadiths = [], nasaiHadiths = [];
let malikHadiths = [], ibnMajahHadiths = [], darimiHadiths = [], ahmedHadiths = [], abuDawudHadiths = [];

const urls = {
  bukhari:   "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/bukhari.json?alt=media&token=1276aa2e-2ab9-4a62-851a-c82e85e2d8e1",
  muslim:    "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/muslim.json?alt=media&token=0623bfd3-622b-40cc-835d-e32fc8eed566",
  tirmidhi:  "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/tirmidhi.json?alt=media&token=7df7efae-3c6a-4122-8f24-ea5f564c5888",
  nasai:     "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/nasai.json?alt=media&token=a478d55f-2f82-429f-9342-927e63cb37f8",
  malik:     "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/malik.json?alt=media&token=4a721b08-df53-4687-87a4-56c04d142b66",
  ibnmajah:  "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/ibnmajah.json?alt=media&token=b55c7a70-e6f1-4627-855e-4ad281a554f8",
  darimi:    "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/darimi.json?alt=media&token=c7f3f2e7-55b9-470c-a155-0a371215338c",
  ahmed:     "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/ahmed.json?alt=media&token=3ab8844d-9fac-4a4e-83a2-14edcf324e7f",
  abudawud:  "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/abudawud.json?alt=media&token=903057ad-8f4f-4c86-b401-d1fbc09d8d56"
};

async function loadHadiths() {
  try {
    const results = await Promise.all(Object.values(urls).map(u => axios.get(u)));
    const collections = Object.keys(urls);
    results.forEach((res, i) => {
      const arr = Array.isArray(res.data.hadiths) ? res.data.hadiths : [];
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

// ─── Fuse.js Setup ─────────────────────────────────────────────────────────────
let fuse;
function initFuse() {
  const allHadiths = [
    ...bukhariHadiths, ...muslimHadiths, ...tirmidhiHadiths,
    ...nasaiHadiths, ...malikHadiths, ...ibnMajahHadiths,
    ...darimiHadiths, ...ahmedHadiths, ...abuDawudHadiths
  ];

  // Prepare data for Fuse search - we keep the full hadith object as 'hadith'
  const fuseData = allHadiths.map(h => {
    let en = "";
    if (typeof h.english === "string") en = h.english;
    else if (h.english && typeof h.english === "object")
      en = h.english.text || h.english.body || "";
    else if (typeof h.text === "string") en = h.text;
    else if (typeof h.body === "string") en = h.body;

    return {
      text: `${normalize(en)} ${(names[h.collection] || "").toLowerCase()} ${h.hadithnumber || h.id || h.number || ""}`,
      hadith: h
    };
  });

  fuse = new Fuse(fuseData, {
    includeScore: true,
    threshold: 0.2,
    ignoreLocation: true,
    keys: ['text']
  });
}

// ─── 5) SEARCH HELPER using Fuse.js ─────────────────────────────────────────────
function searchHadiths(query) {
  const q = query.toLowerCase().trim();
  const keywords = extractKeywords(q);
  if (!q || keywords.length === 0 || !fuse) return [];

  // Fuse search returns array of results with .item
  const results = fuse.search(q);
  // We map to the original hadith object
  return results.slice(0, 10).map(r => r.item.hadith);
}

// ─── 6) SEARCH ENDPOINT ───────────────────────────────────────────────────────
app.post("/search-hadith", async (req, res) => {
  const q = (req.body.query || "").trim();
  const matches = searchHadiths(q);

  if (matches.length) {
    const result = matches.map(h => {
      let en = "";
      if (typeof h.english === "string") en = h.english;
      else if (h.english && typeof h.english === "object")
        en = h.english.text || h.english.body || "";
      else if (typeof h.text === "string") en = h.text;
      else if (typeof h.body === "string") en = h.body;

      const ar  = h.arabic || "[No Arabic]";
      const num = h.hadithnumber || h.id || h.number || "Unknown";
      const ref = `${names[h.collection] || "Unknown"} ${num}`;
      return `---\nArabic Matn: ${ar}\nEnglish Matn: ${en}\nReference: ${ref}`;
    }).join("\n");
    return res.json({ result });
 } else {
 // ─── 7) GPT FALLBACK ─────────────────────────────────────────────────────────
  try {
    const prompt =
      `You are a specialist Islamic AI scholar trained strictly according to the Islamic hadith scholarly tradition, including Ibn Taymiyyah, Ibn al-Qayyim, Al-Albani, Ibn Baz, Ibn Uthaymeen, Ibn Hajar, Al-Dhahabi, and Al-Shafi'i.\n\n` +
      `Your task is, given a hadith or statement:\n\n` +
      `Clearly state whether this hadith is authentic, weak, fabricated, or not found in the major hadith collections (Bukhari, Muslim, Tirmidhi, Abu Dawood, Ibn Majah, Nasai, Malik, Ahmad, Darimi).\n\n` +
      `If weak or fabricated, give a clear, brief explanation why—explicitly citing names of classical scholars or authoritative sources who rejected or weakened it (like Al-Albani, Ibn Hajar, or Al-Dhahabi). If uncertain, clearly say "Status uncertain."\n\n` +
      `If fabricated, briefly recommend an authentic (sahih) hadith that closely matches the meaning.\n\n` +
      `NEVER fabricate or guess sources, narrators, or grades. If unsure, explicitly say "Unclear status" rather than guessing.\n\n` +
      `Provide a short and concise reasoning why this hadith or idea is problematic or accepted in mainstream Sunni Islam.\n\n` +
      `Respond with short, clear, separate paragraphs—each paragraph with one key idea. Avoid long, dense blocks of text. Use easy-to-understand language for a general audience.\n\n` +
      `Hadith or statement to analyze:\n\n"${q}"\n\n`;

    const ai = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "openai/gpt-4o-mini",
        messages: [{ role: "system", content: prompt }],
        max_tokens: 500
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

     let raw = "";
      if (ai.data?.choices?.[0]?.message?.content) {
        raw = ai.data.choices[0].message.content.trim();
      }
      raw = raw.replace(/([.?!])\s*/g,"$1\n\n");

       const result =
        `---\nEnglish Matn: ${raw}\nReference: AI Generated\n` +
        `Warning: This particular phrase/word is not found in the 9 main books. ` +
        `Try rephrasing, using specific hadith phrases, or checking spelling.`;

      return res.json({ result });
    } catch (err) {
      console.error("❌ AI fallback error:", err.message);
      return res.json({ result: `❌ No authentic hadith found.` });
    }
  }
});

// ─── 8) COMMENTARY ENDPOINT ───────────────────────────────────────────────────
app.post('/gpt-commentary', async (req, res) => {
  const englishFull = (req.body.english || '').trim();
  const arabicFull  = (req.body.arabic  || '').trim();
  const reference   = (req.body.reference || '').trim();
  const collection  = (req.body.collection || '').trim().toLowerCase();

  // Defensive: Always return all 3 fields
  const errorPayload = {
    commentary: 'No commentary.',
    chain: 'No chain.',
    evaluation: 'No evaluation.'
  };

  if (!englishFull || !arabicFull || !reference || !collection) {
    return res.json({
      commentary: 'Error: Missing required field.',
      chain: '',
      evaluation: ''
    });
  }

  const cacheKey = `${reference}|${collection}`;
  if (commentaryCache[cacheKey]) {
    return res.json(commentaryCache[cacheKey]);
  }

  const snippet = truncate(englishFull, 500);
  const systemPrompt =
    `You are a specialist in Hadith sciences, trained on the methodology of Salafi scholars like Ibn Taymiyyah, Ibn al-Qayyim, Al-Albani, Ibn Baz, Ibn Uthaymeen, as well as classical scholars like Ibn Hajar, Al-Dhahabi, and Al-Shafi'i.\n` +
    `Output exactly these three sections in order and nothing else:\n` +
    `Commentary: 3–4 sentences explaining context, meaning, and importance but **do not comment on the chain** here. If the hadith is from Sahih Bukhari, base the explanation on Fath al-Bari by Ibn Hajar. If the hadith is from Sahih Muslim, base the explanation on Sharh of Imam Nawawi. If neither is available, provide a general context explanation from the known Sunnah.\n` +
    `Chain of Narrators: extract from the Arabic text and transliterate into English, separated by →.\n` +
    `Evaluation of Hadith: - Provide a **brief but accurate** analysis of the chain's strength or weakness, based **only on the known status of narrators**. 
    - If a narrator is known to be weak, explicitly mention it and why (e.g., "X is considered weak by Al-Albani").
    - If there is a known disconnection (e.g., mursal, missing link), say it clearly.
    - If the chain is from Sahih Bukhari or Sahih Muslim, **always state: "Chain is sound and reliable by default."**
    - If a narrator's status is unknown, say: "Status of [name] is unclear."

Be concise, precise, and avoid fabricating any sources or narrators.`;

  const userPrompt =
    `Reference: ${reference}\n` +
    `Collection: ${collection}\n` +
    `Hadith (Arabic): ${arabicFull}\n` +
    `Hadith (English): ${snippet}`;

  try {
    const aiResp = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'openai/gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        temperature: 0.0,
        max_tokens: 600
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    let raw = aiResp.data.choices[0]?.message?.content || '';
    raw = raw.replace(/```[\\s\\S]*?```/g, '').trim();

    // More forgiving regex:
    const commentaryMatch = raw.match(/Commentary[^:]*:\s*([\s\S]*?)(?=Chain of Narrators[^:]*:)/i);
    const chainMatch      = raw.match(/Chain of Narrators[^:]*:\s*([\s\S]*?)(?=Evaluation[^:]*:)/i);
    const evalMatch       = raw.match(/Evaluation[^:]*:\s*([\s\S]*)/i);

    const payload = {
      commentary: commentaryMatch && commentaryMatch[1].trim() ? commentaryMatch[1].trim() : 'No commentary.',
      chain:      chainMatch && chainMatch[1].trim() ? chainMatch[1].trim() : 'No chain.',
      evaluation: evalMatch && evalMatch[1].trim() ? evalMatch[1].trim() : 'No evaluation.'
    };

    if (['bukhari', 'muslim'].includes(collection)) {
  payload.evaluation = 'Chain is sound and reliable by default.';
}
    
    commentaryCache[cacheKey] = payload;
    return res.json(payload);

  } catch (err) {
    console.error('❌ Commentary error:', err.response?.data || err.message);
    return res.json(errorPayload);
  }
});

// ─── 9) START SERVER ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Takhrij backend running on port ${PORT}`));
