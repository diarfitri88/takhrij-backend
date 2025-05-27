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
  muslim:    "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/muslim.json?alt=media&token=95adbddd-1823-4a6b-91cb-371053712639",
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
    threshold: 0.3,
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
  }

  // ─── 7) GPT FALLBACK ─────────────────────────────────────────────────────────
  try {
    const prompt = 
      `You are a knowledgeable Islamic scholar AI trained on the methodology of Salafi scholars such as Ibn Taymiyyah, Ibn al-Qayyim, Al-Albani, Ibn Baz, Ibn Uthaymeen, and classical scholars like Ibn Hajar, Al-Dhahabi, and Al-Shafi’i.

When given a hadith or statement, you will:

1. Confirm whether it is authentic, weak, fabricated, or not found in the main hadith collections. If it is fabricated, suggest a sahih hadith that matches closest to it.
2. If it is weak or fabricated, explain clearly why, citing well-known classical scholars or books who discussed or rejected it.
3. Provide reasoning behind why the notion is rejected in mainstream Sunni Islam.
4. Avoid fabricating sources or chains of narration.
5. Be concise but informative and clear.

Here is the hadith or statement to analyze:

${q}"

`;

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
    if (
      ai.data &&
      Array.isArray(ai.data.choices) &&
      ai.data.choices[0] &&
      ai.data.choices[0].message &&
      typeof ai.data.choices[0].message.content === "string"
    ) {
      raw = ai.data.choices[0].message.content.trim();
    }

    const result =
      `---\n` +
      `English Matn: ${raw}\n` +
      `Reference: AI Generated\n` +
      `Warning: This hadith is not found in the 9 main books. ` +
      `Try rephrasing, using specific hadith phrases, or checking spelling.`;

    return res.json({ result });
  } catch (err) {
    console.error("❌ AI fallback error:", err.message);
    return res.json({ result: `❌ No authentic hadith found.` });
  }
});

// ─── 8) COMMENTARY ENDPOINT ────────────────────────────────────────────────────
app.post("/gpt-commentary", async (req, res) => {
  const englishFull = (req.body.english || "").trim();
  const arabicFull  = (req.body.arabic   || "").trim();
  const reference   = (req.body.reference || "").trim();
  const collection  = (req.body.collection || "").trim();
  const cacheKey    = reference + "|" + collection;

  if (!englishFull || !arabicFull || !reference || !collection) {
    return res.status(400).json({ error: "Missing Arabic, English, reference, or collection." });
  }

  const snippet = truncate(englishFull, 500);

  if (commentaryCache[cacheKey]) {
    return res.json({ commentary: commentaryCache[cacheKey] });
  }

  const messages = [
    {
      role: "system",
      content: `
You are a specialist in the sciences of Hadith studies. For each request, output:

Commentary: 3–4 sentences explaining context, meaning, and importance according to salafi scholars without mentioning the word 'salafi'.
Evaluation of Hadith: Briefly analyze the chain’s quality (e.g., “All companions in chain—very strong,” “Contains weak narrator X—proceed with caution,” or “No known weakness”).
Chain of Narrators: Give an **English transliteration** for each name, in the same order. narrator1 → narrator2 → …

Do NOT grade Sahih/Da‘if/etc., and do NOT invent sources. Simply explain and list. For hadith in Sahih Bukhari and Sahih Muslim, just state that the hadith is sound.

`
    },
    {
      role: "user",
      content: `Hadith Reference: ${reference}
Hadith (Arabic): ${arabicFull}
Hadith (English): ${snippet}`
    }
  ];

  try {
    const aiResp = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model:       "openai/gpt-4o-mini",
        messages,
        temperature: 0.0,
        max_tokens:  500
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "X-Title": "Takhrij Commentary"
        }
      }
    );

    const commentary = aiResp.data.choices[0]?.message?.content?.trim()
      || "No commentary received.";

    commentaryCache[cacheKey] = commentary;
    return res.json({ commentary });

  } catch (error) {
    console.error("❌ Commentary error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to fetch commentary." });
  }
});


// ─── 9) START SERVER ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Takhrij backend running on port ${PORT}`));
