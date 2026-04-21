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
  const KEY = process.env.RAPIDAPI_KEY;
  if (!KEY) return res.status(500).json({ error: 'RAPIDAPI_KEY not configured', matches: [] });
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
  const KEY = process.env.RAPIDAPI_KEY;
  if (!KEY) return res.status(500).json({ error: 'RAPIDAPI_KEY not configured' });
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

// ─── /api/league-matches + /api/live-scores ──────────────

const leagueRoundsCache = new Map(); // `${sport}:${tid}` → {rounds, sortedRounds, currentRound, ts}
const leagueCache       = new Map(); // `${sport}:${tid}:${journee}` → {data, ts}
const liveScoreCache    = new Map(); // `${matchId}` → {data, ts}

async function getLeagueRounds(sport, tournamentId, KEY) {
  const cacheKey = `${sport}:${tournamentId}`;
  const cached = leagueRoundsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 1_800_000) return cached;

  const today = new Date();
  const hdr   = { 'x-rapidapi-host': SPORT_HOST, 'x-rapidapi-key': KEY };

  // Fetch 23 dates: -11 to +11 — pour détecter la journée en cours
  const offsets = Array.from({ length: 23 }, (_, i) => i - 11);
  const results = await Promise.all(
    offsets.map(offset => {
      const d = new Date(today);
      d.setDate(d.getDate() + offset);
      const dateStr = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
      return fetch(`${SPORT_BASE}/api/v1/sport/${sport}/scheduled-events/${dateStr}`, { headers: hdr })
        .then(r => r.ok ? r.json() : { events: [] })
        .catch(() => ({ events: [] }));
    })
  );

  // Collecter les events du tournoi + extraire seasonId
  let seasonId = null;
  const roundsWindow = new Map();
  results.forEach(data => {
    (data?.events || []).forEach(e => {
      if (Number(e?.tournament?.uniqueTournament?.id) === tournamentId && e.id) {
        if (!seasonId && e.season?.id) seasonId = e.season.id;
        const round = e.roundInfo?.round;
        if (round != null) {
          if (!roundsWindow.has(round)) roundsWindow.set(round, []);
          roundsWindow.get(round).push(e);
        }
      }
    });
  });

  const sortedRounds = [...roundsWindow.keys()].sort((a, b) => a - b);

  // Journée en cours = première journée où tous les matchs ne sont PAS terminés
  let currentRound = sortedRounds[sortedRounds.length - 1] ?? null;
  for (const r of sortedRounds) {
    const events     = roundsWindow.get(r);
    const meaningful = events.filter(e => e.status?.type !== 'canceled');
    if (!meaningful.length) continue;
    if (!meaningful.every(e => e.status?.type === 'finished')) {
      currentRound = r;
      break;
    }
  }

  const result = { currentRound, seasonId, ts: Date.now() };
  leagueRoundsCache.set(cacheKey, result);
  return result;
}

// Récupère TOUS les matchs d'une journée via l'endpoint dédié Sofascore
async function fetchRoundEvents(tournamentId, seasonId, round, KEY) {
  const hdr = { 'x-rapidapi-host': SPORT_HOST, 'x-rapidapi-key': KEY };
  const url = `${SPORT_BASE}/api/v1/unique-tournament/${tournamentId}/season/${seasonId}/events/round/${round}`;
  const data = await fetch(url, { headers: hdr })
    .then(r => r.ok ? r.json() : { events: [] })
    .catch(() => ({ events: [] }));
  return (data?.events || []).sort((a, b) => (a.startTimestamp || 0) - (b.startTimestamp || 0));
}

function mapEventStatus(type) {
  if (type === 'finished')    return 'finished';
  if (type === 'inprogress')  return 'live';
  if (type === 'postponed')   return 'postponed';
  if (type === 'canceled')    return 'canceled';
  return 'scheduled';
}

function mapEventToMatch(e) {
  const d = e.startTimestamp ? new Date(e.startTimestamp * 1000) : null;
  return {
    id:        e.id,
    homeTeam:  e.homeTeam?.name || '?',
    awayTeam:  e.awayTeam?.name || '?',
    homeLogo:  e.homeTeam?.id ? `https://api.sofascore.app/api/v1/team/${e.homeTeam.id}/image` : null,
    awayLogo:  e.awayTeam?.id ? `https://api.sofascore.app/api/v1/team/${e.awayTeam.id}/image` : null,
    startTime: d ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '--:--',
    startDate: d ? d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'Europe/Paris' }) : 'TBD',
    status:    mapEventStatus(e.status?.type),
    score:     (e.homeScore?.current != null && e.awayScore?.current != null)
                 ? { home: e.homeScore.current, away: e.awayScore.current }
                 : null,
    tournament: e.tournament?.name || '',
  };
}

app.get('/api/team-logo', async (req, res) => {
  const { id } = req.query;
  if (!id || !/^\d+$/.test(id)) return res.status(400).end();
  try {
    const r = await fetch(`https://api.sofascore.app/api/v1/team/${id}/image`);
    if (!r.ok) return res.status(404).end();
    res.set('Content-Type', r.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    const buf = await r.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch { res.status(502).end(); }
});

const LEAGUE_TTL = { current: 1_800_000, previous: 86_400_000, next: 43_200_000 };

app.get('/api/league-matches', async (req, res) => {
  const sport      = req.query.sport || 'football';
  const tournament = parseInt(req.query.tournament);
  const journee    = req.query.journee || 'current';

  if (!req.query.tournament || isNaN(tournament))
    return res.status(400).json({ error: 'Missing or invalid tournament' });

  const KEY = process.env.RAPIDAPI_KEY;
  if (!KEY) return res.status(500).json({ error: 'RAPIDAPI_KEY not configured' });

  const cacheKey = `${sport}:${tournament}:${journee}`;
  const ttl      = LEAGUE_TTL[journee] ?? 1_800_000;
  const cached   = leagueCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ttl) return res.json(cached.data);

  try {
    const { currentRound, seasonId } = await getLeagueRounds(sport, tournament, KEY);

    if (currentRound == null || !seasonId)
      return res.json({ journee: 0, matches: [], journeeInfo: { current: 0, previous: 0, next: 0 } });

    // Navigation par numéro de journée — pas par fenêtre de dates
    const previousRound = currentRound > 1 ? currentRound - 1 : null;
    const nextRound     = currentRound + 1;
    const targetRound   = { current: currentRound, previous: previousRound, next: nextRound }[journee];

    if (targetRound == null)
      return res.json({
        journee: 0, matches: [],
        journeeInfo: { current: currentRound, previous: previousRound ?? 0, next: nextRound },
      });

    // Fetch tous les matchs de la journée via l'endpoint dédié
    const events  = await fetchRoundEvents(tournament, seasonId, targetRound, KEY);
    const matches = events.map(mapEventToMatch);

    const result = {
      journee: targetRound,
      matches,
      journeeInfo: {
        current:  currentRound,
        previous: previousRound ?? 0,
        next:     nextRound,
      },
    };

    leagueCache.set(cacheKey, { data: result, ts: Date.now() });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/live-scores', async (req, res) => {
  const { matchIds } = req.query;
  if (!matchIds) return res.status(400).json({ error: 'Missing matchIds' });

  const KEY = process.env.RAPIDAPI_KEY;
  if (!KEY) return res.status(500).json({ error: 'RAPIDAPI_KEY not configured' });

  const ids = matchIds.split(',').map(id => id.trim()).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'No valid matchIds' });

  const hdr = { 'x-rapidapi-host': SPORT_HOST, 'x-rapidapi-key': KEY };
  const now = Date.now();

  const results = await Promise.all(ids.map(async id => {
    const cached = liveScoreCache.get(id);
    if (cached && now - cached.ts < 60_000) return cached.data;

    try {
      const data = await fetch(`${SPORT_BASE}/api/v1/event/${id}`, { headers: hdr })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);

      const ev = data?.event;
      if (!ev) return null;

      const desc  = ev.status?.description || '';
      const mMin  = desc.match(/(\d+)['′]/);
      const minute = mMin ? parseInt(mMin[1]) : (ev.time?.played ?? null);

      const result = {
        id,
        score:  (ev.homeScore?.current != null && ev.awayScore?.current != null)
                  ? { home: ev.homeScore.current, away: ev.awayScore.current }
                  : null,
        status: mapEventStatus(ev.status?.type),
        minute,
      };

      liveScoreCache.set(id, { data: result, ts: now });
      return result;
    } catch {
      return null;
    }
  }));

  res.json(results.filter(Boolean));
});

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
