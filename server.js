import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';

import matchesHandler from './api/matches.js';
import chatHandler    from './api/chat.js';

const app     = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());

// ─── API routes ───────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl: 'https://txifvjkpajnmbnadvcah.supabase.co',
    supabaseKey: process.env.SUPABASE_ANON_KEY || '',
  });
});

app.get('/api/matches', (req, res) => matchesHandler(req, res));

// ─── helpers Poisson ──────────────────────────────────────
function poissonP(lambda, k) {
  let f = 1; for (let i = 2; i <= k; i++) f *= i;
  return Math.pow(lambda, k) * Math.exp(-lambda) / f;
}
function matchScore(lH, lA) {
  const MAX = 8; let hw = 0, dr = 0, aw = 0, o25 = 0, btts = 0;
  for (let h = 0; h <= MAX; h++) {
    const ph = poissonP(lH, h);
    for (let a = 0; a <= MAX; a++) {
      const p = ph * poissonP(lA, a);
      if (h > a) hw += p; else if (h === a) dr += p; else aw += p;
      if (h + a > 2.5) o25 += p;
    }
  }
  btts = (1 - Math.exp(-lH)) * (1 - Math.exp(-lA));
  const conf = Math.min(93, Math.max(42, Math.round(btts * 25 + o25 * 25 + 18)));
  return {
    homeWin: Math.round(hw * 100), draw: Math.round(dr * 100),
    awayWin: Math.round(aw * 100),
    btts: Math.round(btts * 100), over25: Math.round(o25 * 100),
    confidence: conf,
  };
}

// ─── SportAPI (Sofascore) ─────────────────────────────────
const SPORT_HOST = 'sportapi7.p.rapidapi.com';
const SPORT_BASE = `https://${SPORT_HOST}`;
const LEAGUES = {
  17:  { name: 'Premier League',   lH: 1.45, lA: 1.10 },
  34:  { name: 'Ligue 1',          lH: 1.35, lA: 1.05 },
  8:   { name: 'La Liga',          lH: 1.40, lA: 1.10 },
  23:  { name: 'Serie A',          lH: 1.30, lA: 1.00 },
  35:  { name: 'Bundesliga',       lH: 1.55, lA: 1.20 },
  7:   { name: 'Champions League', lH: 1.25, lA: 1.00 },
};

app.get('/api/today', async (req, res) => {
  const KEY   = process.env.RAPIDAPI_KEY || '47025106d4msh3f5ff29ba28372ap1938b7jsnd189477d3b6a';
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const hdr   = { 'x-rapidapi-host': SPORT_HOST, 'x-rapidapi-key': KEY };

  try {
    const data = await fetch(`${SPORT_BASE}/api/v1/sport/football/scheduled-events/${today}`, { headers: hdr }).then(r => r.json());

    const events = (data?.events || []).filter(e => {
      const tid = e?.tournament?.uniqueTournament?.id;
      return tid && LEAGUES[tid];
    });

    if (!events.length) return res.json({ matches: [] });

    const matches = events.map((e, idx) => {
      const tid    = e.tournament?.uniqueTournament?.id;
      const league = LEAGUES[tid] || { name: e.tournament?.name || 'Ligue', lH: 1.35, lA: 1.05 };
      const { lH, lA } = league;
      const stats  = matchScore(lH, lA);
      const d      = e.startTimestamp ? new Date(e.startTimestamp * 1000) : null;
      return {
        id:          e.id || idx,
        home:        e.homeTeam?.name || '?',
        away:        e.awayTeam?.name || '?',
        competition: league.name,
        time:        d ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '--:--',
        date:        d ? d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'Europe/Paris' }) : "Aujourd'hui",
        ...stats,
        goalsHome: +lH.toFixed(1), goalsAway: +lA.toFixed(1),
        formHome: ['?','?','?','?','?'], formAway: ['?','?','?','?','?'],
        btts:   Math.min(90, Math.max(20, stats.btts)),
        over25: Math.min(90, Math.max(15, stats.over25)),
      };
    }).sort((a, b) => (b.btts + b.over25) - (a.btts + a.over25));

    res.json({ matches: matches.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message, matches: [] });
  }
});

app.get('/api/fixture', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const KEY = process.env.RAPIDAPI_KEY || '47025106d4msh3f5ff29ba28372ap1938b7jsnd189477d3b6a';
  const hdr = { 'x-rapidapi-host': SPORT_HOST, 'x-rapidapi-key': KEY };
  try {
    const data = await fetch(`${SPORT_BASE}/api/v1/event/${id}`, { headers: hdr }).then(r => r.json());
    const ev = data?.event;
    if (!ev) return res.json({ status: null });
    const type = ev.status?.type;
    const desc = ev.status?.description || '';
    let statusShort = 'NS';
    if (type === 'finished')    statusShort = 'FT';
    else if (type === 'inprogress') {
      if (/halftime|half.time/i.test(desc)) statusShort = 'HT';
      else if (/2nd/i.test(desc))           statusShort = '2H';
      else                                  statusShort = '1H';
    } else if (type === 'postponed') statusShort = 'PST';
    else if (type === 'canceled')    statusShort = 'CANC';
    res.json({
      status:    statusShort,
      homeGoals: ev.homeScore?.current ?? null,
      awayGoals: ev.awayScore?.current ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Groq AI chat ─────────────────────────────────────────
app.post('/api/ai-chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });
  const KEY = process.env.GROQ_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'AI unavailable' });
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: "Tu es BetVision AI, assistant d'analyse statistique football. Utilise uniquement les termes: analyse statistique, algorithme prédictif, outil d'aide à la décision. Jamais: pronos, paris. Réponds en français, concis." },
          ...history,
          { role: 'user', content: message },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });
    if (!r.ok) return res.status(500).json({ error: 'AI unavailable' });
    const data = await r.json();
    res.json({ reply: data.choices?.[0]?.message?.content || '' });
  } catch {
    res.status(500).json({ error: 'AI unavailable' });
  }
});

// ─── NewsAPI proxy avec cache 1h ──────────────────────────
let newsCache = { data: null, ts: 0 };
app.get('/api/news', async (req, res) => {
  const KEY  = process.env.NEWS_API_KEY;
  const now  = Date.now();
  const hour = new Date().getHours();
  const age  = now - newsCache.ts;
  if (newsCache.data && (hour < 8 || age < 3_600_000)) return res.json(newsCache.data);
  if (!KEY) {
    if (newsCache.data) return res.json(newsCache.data);
    return res.status(500).json({ error: 'NEWS_API_KEY not configured' });
  }
  try {
    const r = await fetch('https://newsapi.org/v2/everything?q=football&language=fr&sortBy=publishedAt&pageSize=10', {
      headers: { 'X-Api-Key': KEY },
    });
    const data = await r.json();
    const articles = (data.articles || []).map(a => ({
      title:       a.title,
      description: a.description,
      url:         a.url,
      image:       a.urlToImage,
      source:      a.source?.name,
      publishedAt: a.publishedAt,
    }));
    newsCache = { data: articles, ts: now };
    res.json(articles);
  } catch {
    if (newsCache.data) return res.json(newsCache.data);
    res.status(500).json({ error: 'News unavailable' });
  }
});

app.options('/api/chat', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});
app.post('/api/chat', (req, res) => chatHandler(req, res));

// ─── Fichiers statiques (index.html, etc.) ────────────────
app.use(express.static(__dirname));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Démarrage ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BetVision AI démarré sur le port ${PORT}`);
});
