// ============================================================
// NEWS.JS — The Fundamental Brain (Gemini-powered)
// News is not decoration here. It has veto power over the engine.
// Two jobs:
//   1. Event lockout — suppress trading around high-impact releases
//   2. Sentiment reasoning — Gemini reads headlines, scores the
//      macro environment, and explains its reasoning in plain English
// ============================================================

const GEMINI_KEY = process.env.GEMINI_API_KEY;   // aistudio.google.com key
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const NEWS_API_KEY = process.env.NEWS_API_KEY;   // newsapi.org free tier

// ---------- 1. Economic calendar lockout ----------

const RECURRING_EVENTS = [
  { day: 5, hour: 8, min: 30, name: "NFP (first Friday)", firstWeekOnly: true },
  { day: 3, hour: 14, min: 0,  name: "FOMC Minutes / Rate Decision (check calendar)", approximate: true },
];

const LOCKOUT_MINUTES_BEFORE = 20;
const LOCKOUT_MINUTES_AFTER = 20;

function checkEventLockout(now = new Date()) {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  const minutesNow = et.getHours() * 60 + et.getMinutes();

  for (const ev of RECURRING_EVENTS) {
    if (ev.day !== day) continue;
    if (ev.firstWeekOnly && et.getDate() > 7) continue;
    const evMinutes = ev.hour * 60 + ev.min;
    if (minutesNow >= evMinutes - LOCKOUT_MINUTES_BEFORE &&
        minutesNow <= evMinutes + LOCKOUT_MINUTES_AFTER) {
      return ev.name;
    }
  }
  return null;
}

// ---------- 2. Headline fetch ----------

async function fetchHeadlines() {
  if (!NEWS_API_KEY) return null;
  try {
    const url = `https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=12&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.articles) return null;
    return data.articles.map(a => ({
      title: a.title,
      source: a.source?.name,
      publishedAt: a.publishedAt,
    }));
  } catch (e) {
    console.error("Headline fetch failed:", e.message);
    return null;
  }
}

// ---------- 3. Sentiment reasoning via Gemini ----------

let sentimentCache = { data: null, fetchedAt: 0 };
const SENTIMENT_TTL_MS = 10 * 60 * 1000; // re-score every 10 minutes

async function getSentiment(symbolContext = "US equity index futures (ES/NQ)") {
  if (sentimentCache.data && Date.now() - sentimentCache.fetchedAt < SENTIMENT_TTL_MS) {
    return sentimentCache.data;
  }

  const headlines = await fetchHeadlines();
  if (!headlines || !GEMINI_KEY) return null;

  const prompt = `You are the fundamental analysis layer of a trading system for ${symbolContext}.

Here are the current top business headlines:
${headlines.map((h, i) => `${i + 1}. [${h.source}] ${h.title}`).join("\n")}

Score the macro environment for the next few hours of trading.
Respond ONLY with raw JSON, no markdown fences, no preamble:
{
  "score": <number from -1 (strongly bearish) to 1 (strongly bullish)>,
  "label": "<bearish | mildly bearish | neutral | mildly bullish | bullish>",
  "summary": "<one sentence: the dominant narrative and why it matters for index futures>",
  "key_risks": ["<up to 3 short risk phrases>"]
}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 500,
          responseMimeType: "application/json", // Gemini's native JSON mode
        },
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    sentimentCache = { data: parsed, fetchedAt: Date.now() };
    return parsed;
  } catch (e) {
    console.error("Gemini sentiment scoring failed:", e.message);
    return null;
  }
}

// ---------- Public interface ----------

async function getNewsContext(symbolContext) {
  const eventLockout = checkEventLockout();
  const sentiment = await getSentiment(symbolContext);
  return { eventLockout, sentiment, asOf: new Date().toISOString() };
}

module.exports = { getNewsContext, checkEventLockout, getSentiment };
