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
app.use(express.json());

// ─── 0) CACHE FOR COMMENTARY ───────────────────────────────────────────────────
const commentaryCache = {};

// ─── RATE LIMITING (Rolling 24-hour limit per IP) ───────────────────────────────
const aiCallTracker = {}; // { 'IP': { count: x, lastReset: timestamp } }

const MAX_CALLS = 15;
const TIME_LIMIT = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

function checkAiLimit(ip) {
  const now = Date.now();

  if (!aiCallTracker[ip]) {
    aiCallTracker[ip] = { count: 0, lastReset: now };
  }

  // Reset if 24 hours passed since lastReset
  if (now - aiCallTracker[ip].lastReset >= TIME_LIMIT) {
    aiCallTracker[ip].count = 0;
    aiCallTracker[ip].lastReset = now;
  }

  if (aiCallTracker[ip].count >= MAX_CALLS) {
    return false; // Limit reached
  }

  aiCallTracker[ip].count++;
  return true; // Allowed
}
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

// ─── HELPER: Check if Hadith is Mutawatir ───────────────────────────────────────
function checkMutawatir(reference) {
  return mutawatirData.mutawatirHadiths.find(h => 
    h.reference.some(r => reference.toLowerCase().includes(r.toLowerCase()))
  ) || null;
}

// ─── 4) LOAD HADITH COLLECTIONS ────────────────────────────────────────────────
let bukhariHadiths = [], muslimHadiths = [], tirmidhiHadiths = [], nasaiHadiths = [];
let malikHadiths = [], ibnMajahHadiths = [], darimiHadiths = [], ahmedHadiths = [], abuDawudHadiths = [];

const urls = {
  bukhari:   "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/bukhari.json?alt=media&token=1276aa2e-2ab9-4a62-851a-c82e85e2d8e1",
  muslim:    "https://firebasestorage.googleapis.com/v0/b/takhrij-json.firebasestorage.app/o/muslim.json?alt=media&token=12c405b8-1882-4c93-b584-6c1e397aa553",
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
      const ref = h.reference || `${names[h.collection] || "Unknown"} ${h.hadithnumber || h.id || h.number || "Unknown"}`;
       // Mutawatir Check
  const mutawatirInfo = checkMutawatir(ref);
  const classification = mutawatirInfo
    ? `Classification: Mutawatir\nNotes: ${mutawatirInfo.notes}`
    : `Classification: Ahad`;

      return `---\nArabic Matn: ${ar}\nEnglish Matn: ${en}\nReference: ${ref}\n${classification}`;
    }).join("\n");
    return res.json({ result });
 } else {
// ─── GPT FALLBACK ─────────────────────────────────────────────────────────
  try {
   const q = (req.body.query || '').trim();
if (!q) {
  return res.json({ result: '❌ No query provided.' });
}   
    const prompt = `
You are a hadith researcher trained on the Salafi methodology, including the works of Ibn Taymiyyah, Ibn al-Qayyim, Al-Albani, Ibn Baz, and Ibn Hajar.

The user submitted a phrase that may NOT be found in the 9 primary hadith collections: Sahih Bukhari, Sahih Muslim, Sunan Abu Dawood, Jami' at-Tirmidhi, Sunan Ibn Majah, Sunan an-Nasa'i, Musnad Ahmad, Muwatta Malik, and Sunan ad-Darimi. The phrase may be misquoted or inaccurately phrased.

You MUST write exactly 4 short paragraphs.

Each paragraph must be followed by **two real line breaks**, use this exact format like this:

If the phrase is authentic, provide the exact hadith and its grading.

If the hadith is not found in the 9 books, say so clearly with no ambiguity.  

Suggest 1 sahih hadith with similar meaning and reference.  

Suggest 3–5 exact **matn-style** English keywords suitable for search that is in the 9 hadith collections (e.g., “moon split”, “smiling is charity”).

Strict rules:
- Use the name “Prophet Muhammad ﷺ” with the salutation.  
- Each paragraph must be **under 80 words**.  
- Do not use Qur’an quotes.  
- Do not combine points into a single paragraph.  
- Do not say “it may be found elsewhere.”  
- Do not apologize or say “feel free to ask.”

Respond in a clear, scholarly tone. Paragraph structure and spacing must be exact.
    `.trim();

    const ai = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: 'deepseek/deepseek-chat-v3-0324:free',
        messages: [
      { role: "system", content: prompt },
      { role: "user", content: q }
    ],
    max_tokens: 1200,
    temperature: 0.0
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

let raw = ai.data.choices[0]?.message?.content || '';
    
raw = raw.replace(/\r\n/g, '\n');
raw = raw.replace(/\n{3,}/g, '\n\n');
raw = raw.replace(/(?<=[a-z0-9])\. (?=[A-Z])/g, '.\n\n'); // keep
raw = raw.replace(/\n{2,}/g, '\n\n');                    // normalize spacing
raw = raw.replace(/([^\n])\n([^\n])/g, '$1 $2');          // fix mid-sentence breaks
raw = raw.trim();
    
    const result =
    `---\nEnglish Matn:\n${raw}\n\n` +
    `Reference: AI Generated\n` +
    `Warning: This phrase/word was not found in any of the 9 primary hadith collections. Try rephrasing it more accurately or using known matn keywords.\n` +
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
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.socket.remoteAddress;
 if (!checkAiLimit(ip)) {
  return res.json({
    commentary: 'Daily AI limit reached. Please try again after 24 hours.',
    chain: '',
    evaluation: ''
  });
}
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
    - If the chain is from Sahih Bukhari or Sahih Muslim, **always state: "Chain is sound and reliable by default."**, if the hadith is widely narrated by multiple companions across different chains, mention: 'Classification: Mutawatir'. Otherwise, consider it Ahad.
    - If a narrator's status is unknown, say: "Status of [name] is unclear."
    - Do NOT attempt to classify a hadith as mutawatir or ahad unless it is explicitly mentioned in reliable classical sources (e.g., Ibn Hajar, Al-Albani). If no explicit mention is available, state: "Classification of ahad or mutawatir not specified."
    - Only classify a hadith as Qudsi, Marfu', or Mawquf if the chain or text explicitly indicates it. If unclear, say: 'Classification of Qudsi, Marfu', or Mawquf not specified.

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
  if (!payload.evaluation.toLowerCase().includes('chain is sound and reliable by default')) {
    payload.evaluation += '\nChain is sound and reliable by default.';
  }
}

    
    commentaryCache[cacheKey] = payload;
    return res.json(payload);

  } catch (err) {
    console.error('❌ Commentary error:', err.response?.data || err.message);
    return res.json(errorPayload);
  }
});
// ─── 9) NARRATOR BIO ───────────────────────────────────────────────────────────
app.post('/narrator-bio', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.json({ bio: 'No narrator name provided.' });
    }

    // 1) System prompt: instructions only, no name interpolation
    const systemPrompt = `
You are a Salafi-trained hadith researcher. The user will give you the name of a narrator. Respond with a structured biography in Markdown using **bold labels only**—no code fences, no bullet points.

Only include confirmed narrators found in the major hadith chains from the 9 primary books: Bukhari, Muslim, Abu Dawood, Tirmidhi, Nasai, Ibn Majah, Ahmad, Malik, and Darimi.

If the narrator is unclear, ambiguous, or not found in the classical rijal books, respond exactly in this format:  
**Narrator unclear:** [Brief reason why the narrator is not known or verified]

Use this exact format:

**Name:** [Full name]  
**Birth:** [Hijri year or estimate]  
**Death:** [Hijri year]  
**Era:** [e.g. Sahabi, Tabi'i, Tabi' al-Tabi'in]  

**Teachers:** [List at least 3–5 known teachers]  

**Students:** [List at least 3–5 known students]  

**Scholarly Remarks:** Summarize what other major scholars said (e.g. Al-Dhahabi, Yahya ibn Ma’in, Al-Nasa’i, Ibn Sa’d, Ibn Hajar, al-Albani).  
If any disagreement exists, explain clearly but briefly.  
End with a clarifying statement if Ibn Hajar maintained his grading in Taqrib al-Tahdib despite criticism.

Now return the full biography for this narrator: **\${name}**
    `.trim();

    // 2) Send the narrator’s name as the user message
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: name }
    ];

    const ai = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-chat-v3-0324:free',
        messages,
        max_tokens: 800,
        temperature: 0.0
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // 3) Don’t strip bold markers—just remove code fences if they appear
    let raw = ai.data.choices[0]?.message?.content || '';
    raw = raw.replace(/```[\s\S]*?```/g, '').trim();

    return res.json({ bio: raw });
  } catch (err) {
    console.error('❌ Narrator bio error:', err.message);
    return res.json({ bio: 'Error fetching biography.' });
  }
});

// ─── 10) START SERVER ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Takhrij backend running on port ${PORT}`));
