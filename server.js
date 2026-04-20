import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';

import chatHandler from './api/chat.js';

const app       = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());

// ─── API routes ───────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl: 'https://txifvjkpajnmbnadvcah.supabase.co',
    supabaseKey: process.env.SUPABASE_ANON_KEY || '',
  });
});

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

// ─── SportAPI (Sofascore) config ──────────────────────────
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

function getApiKey() {
  const k = process.env.RAPIDAPI_KEY;
  if (!k) throw new Error('RAPIDAPI_KEY not configured');
  return k;
}

function dateOffset(offset = 0, tz = 'Europe/Paris') {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('sv-SE', { timeZone: tz });
}

// ─── /api/today — cache 1h ────────────────────────────────
let todayCache = { data: null, ts: 0 };

app.get('/api/today', async (req, res) => {
  try {
    const KEY = getApiKey();
    const now = Date.now();
    if (todayCache.data && now - todayCache.ts < 3_600_000) return res.json(todayCache.data);

    const hdr  = { 'x-rapidapi-host': SPORT_HOST, 'x-rapidapi-key': KEY };
    const data = await fetch(`${SPORT_BASE}/api/v1/sport/football/scheduled-events/${dateOffset(0)}`, { headers: hdr }).then(r => r.json());

    const events = (data?.events || []).filter(e => LEAGUES[e?.tournament?.uniqueTournament?.id]);
    if (!events.length) {
      const empty = { matches: [] };
      todayCache = { data: empty, ts: now };
      return res.json(empty);
    }

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

    const result = { matches: matches.slice(0, 10) };
    todayCache = { data: result, ts: now };
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, matches: [] });
  }
});

// ─── /api/fixture ─────────────────────────────────────────
app.get('/api/fixture', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    const KEY = getApiKey();
    const hdr = { 'x-rapidapi-host': SPORT_HOST, 'x-rapidapi-key': KEY };
    const data = await fetch(`${SPORT_BASE}/api/v1/event/${id}`, { headers: hdr }).then(r => r.json());
    const ev = data?.event;
    if (!ev) return res.json({ status: null });
    const type = ev.status?.type;
    const desc = ev.status?.description || '';
    let statusShort = 'NS';
    if (type === 'finished')      statusShort = 'FT';
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

// ─── /api/league-matches — cache Map ─────────────────────
const leagueCache = new Map();

app.get('/api/league-matches', async (req, res) => {
  const { sport = 'football', tournament, journee = 'current' } = req.query;
  if (!tournament) return res.status(400).json({ error: 'Missing tournament' });

  try {
    const KEY      = getApiKey();
    const tid      = parseInt(tournament);
    const cacheKey = `${sport}:${tid}:${journee}`;
    const hdr      = { 'x-rapidapi-host': SPORT_HOST, 'x-rapidapi-key': KEY };

    // TTL: 30 min current, 24h previous, ∞ next
    const cached = leagueCache.get(cacheKey);
    if (cached) {
      const age = Date.now() - cached.ts;
      const ttl = journee === 'previous' ? 86_400_000 : journee === 'next' ? Infinity : 1_800_000;
      if (age < ttl) return res.json(cached.data);
    }

    // Fetch a window of dates to detect rounds
    const offsets = journee === 'previous' ? [-10,-9,-8,-7,-6,-5,-4,-3]
                  : journee === 'next'     ? [3,4,5,6,7,8,9,10]
                  : [-3,-2,-1,0,1,2,3];

    const responses = await Promise.all(
      offsets.map(o =>
        fetch(`${SPORT_BASE}/api/v1/sport/${sport}/scheduled-events/${dateOffset(o)}`, { headers: hdr })
          .then(r => r.json()).catch(() => ({ events: [] }))
      )
    );

    const allEvents = responses.flatMap(d => d.events || [])
      .filter(e => e.tournament?.uniqueTournament?.id === tid);

    if (!allEvents.length) {
      const empty = { journee: null, matches: [], journeeInfo: { current: null, previous: null, next: null } };
      leagueCache.set(cacheKey, { data: empty, ts: Date.now() });
      return res.json(empty);
    }

    // Group by round number
    const rounds = {};
    allEvents.forEach(e => {
      const rnd = e.roundInfo?.round ?? e.roundInfo?.name ?? 'X';
      if (!rounds[rnd]) rounds[rnd] = [];
      rounds[rnd].push(e);
    });

    const roundNums = Object.keys(rounds).sort((a, b) =>
      (isNaN(a) ? 9999 : Number(a)) - (isNaN(b) ? 9999 : Number(b))
    );

    // Current round = first round not fully finished (excluding cancelled)
    let currentRound = roundNums[roundNums.length - 1];
    for (const rn of roundNums) {
      const nonCancelled = rounds[rn].filter(e => e.status?.type !== 'canceled');
      if (!nonCancelled.every(e => e.status?.type === 'finished')) { currentRound = rn; break; }
    }

    const ci        = roundNums.indexOf(currentRound);
    const prevRound = ci > 0 ? roundNums[ci - 1] : null;
    const nextRound = ci < roundNums.length - 1 ? roundNums[ci + 1] : null;
    const target    = journee === 'previous' ? (prevRound ?? currentRound)
                    : journee === 'next'     ? (nextRound ?? currentRound)
                    : currentRound;

    const toStatus = t =>
      t === 'finished' ? 'finished' : t === 'inprogress' ? 'live' :
      t === 'postponed' ? 'postponed' : t === 'canceled' ? 'canceled' : 'scheduled';

    const matches = (rounds[target] || []).map(e => {
      const type  = e.status?.type;
      const d     = e.startTimestamp ? new Date(e.startTimestamp * 1000) : null;
      const hasScore = type === 'finished' || type === 'inprogress';
      return {
        id:        e.id,
        homeTeam:  e.homeTeam?.name || '?',
        awayTeam:  e.awayTeam?.name || '?',
        homeLogo:  e.homeTeam?.id ? `https://api.sofascore.app/api/v1/team/${e.homeTeam.id}/image` : null,
        awayLogo:  e.awayTeam?.id ? `https://api.sofascore.app/api/v1/team/${e.awayTeam.id}/image` : null,
        startTime: d ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '--:--',
        startDate: d ? d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'Europe/Paris' }) : '',
        status:    toStatus(type),
        score:     hasScore ? { home: e.homeScore?.current ?? 0, away: e.awayScore?.current ?? 0 } : null,
        tournament: e.tournament?.name || '',
      };
    }).sort((a, b) => {
      const o = { live: 0, scheduled: 1, postponed: 2, finished: 3, canceled: 4 };
      return (o[a.status] ?? 5) - (o[b.status] ?? 5);
    });

    const toNum = n => isNaN(n) ? n : Number(n);
    const result = {
      journee:     toNum(target),
      matches,
      journeeInfo: {
        current:  toNum(currentRound),
        previous: prevRound != null ? toNum(prevRound) : null,
        next:     nextRound != null ? toNum(nextRound) : null,
      },
    };

    leagueCache.set(cacheKey, { data: result, ts: Date.now() });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/live-scores — cache 1 min ──────────────────────
const liveScoreCache = new Map();

app.get('/api/live-scores', async (req, res) => {
  const { matchIds } = req.query;
  if (!matchIds) return res.status(400).json({ error: 'Missing matchIds' });
  try {
    const KEY  = getApiKey();
    const ids  = matchIds.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
    const hdr  = { 'x-rapidapi-host': SPORT_HOST, 'x-rapidapi-key': KEY };
    const now  = Date.now();

    const results = await Promise.all(ids.map(async id => {
      const cached = liveScoreCache.get(id);
      if (cached && now - cached.ts < 60_000) return cached.data;
      try {
        const data = await fetch(`${SPORT_BASE}/api/v1/event/${id}`, { headers: hdr }).then(r => r.json());
        const ev   = data?.event;
        if (!ev) return { id, score: null, status: null, minute: null };
        const type   = ev.status?.type;
        const status = type === 'finished' ? 'finished' : type === 'inprogress' ? 'live' : 'scheduled';
        const minute = ev.status?.description?.match(/\d+/)?.[0] ?? null;
        const result = { id, score: { home: ev.homeScore?.current ?? null, away: ev.awayScore?.current ?? null }, status, minute };
        liveScoreCache.set(id, { data: result, ts: now });
        return result;
      } catch {
        return { id, score: null, status: null, minute: null };
      }
    }));

    res.json(results);
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
          { role: 'system', content: "Tu es BetVision AI, assistant d'analyse statistique multi-sport. Tu couvres : football, basketball (NBA), tennis, Formule 1, rugby, baseball (MLB), hockey (NHL) et MMA.\n\nUtilise uniquement ces termes : 'analyse statistique', 'algorithme prédictif', 'outil d'aide à la décision', 'tendances', 'indicateurs de performance'. N'utilise JAMAIS : 'pronos', 'paris', 'parier', 'pronostic' (au sens parieur), 'mise'.\n\nRéponds en français, de manière concise (3-4 phrases max sauf si l'utilisateur demande une analyse détaillée). Adapte le vocabulaire technique au sport évoqué (BTTS/Over pour foot, points/rebonds pour NBA, sets/aces pour tennis, pole position/tours rapides pour F1, etc.)." },
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

// ─── Fichiers statiques ───────────────────────────────────
app.use(express.static(__dirname));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── Démarrage ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BetVision AI démarré sur le port ${PORT}`));
