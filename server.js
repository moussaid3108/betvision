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

  const fetchDate = async (offset) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    const dateStr = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
    const url = `${SPORT_BASE}/api/v1/sport/${sport}/scheduled-events/${dateStr}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, { headers: hdr });
        if (r.ok) return await r.json();
      } catch {}
      await new Promise(res => setTimeout(res, 300 * (attempt + 1)));
    }
    return { events: [] };
  };

  // Scan -14 à +30 jours, par lots de 5 avec 150ms entre chaque lot
  const offsets = Array.from({ length: 45 }, (_, i) => i - 14);
  const results = [];
  for (let i = 0; i < offsets.length; i += 5) {
    const batch = await Promise.all(offsets.slice(i, i + 5).map(fetchDate));
    results.push(...batch);
    if (i + 5 < offsets.length) await new Promise(res => setTimeout(res, 150));
  }

  // Dédupliquer et grouper par journée
  const eventsMap = new Map();
  results.forEach(data => {
    (data?.events || []).forEach(e => {
      if (Number(e?.tournament?.uniqueTournament?.id) === tournamentId && e.id)
        eventsMap.set(e.id, e);
    });
  });

  const rounds = new Map();
  eventsMap.forEach(e => {
    const round = e.roundInfo?.round;
    if (round != null) {
      if (!rounds.has(round)) rounds.set(round, []);
      rounds.get(round).push(e);
    }
  });

  // Trier par date du premier match (pas par numéro de journée)
  const sortedByDate = [...rounds.keys()].sort((a, b) => {
    const minA = Math.min(...rounds.get(a).map(e => e.startTimestamp || Infinity));
    const minB = Math.min(...rounds.get(b).map(e => e.startTimestamp || Infinity));
    return minA - minB;
  });
  const nowTs = Math.floor(Date.now() / 1000);

  // 1. Priorité : round avec des matchs LIVE
  let currentRound = null;
  for (const r of sortedByDate) {
    if (rounds.get(r).some(e => e.status?.type === 'inprogress')) {
      currentRound = r; break;
    }
  }

  // 2. Round dont le prochain match est le plus proche dans le futur
  if (currentRound == null) {
    let minFutureTs = Infinity;
    for (const r of sortedByDate) {
      for (const e of rounds.get(r)) {
        const ts   = e.startTimestamp || 0;
        const type = e.status?.type;
        if (type !== 'finished' && type !== 'canceled' && ts > nowTs - 3600 && ts < minFutureTs) {
          minFutureTs = ts;
          currentRound = r;
        }
      }
    }
  }

  // 3. Fallback
  if (currentRound == null) currentRound = sortedByDate[sortedByDate.length - 1] ?? null;

  const result = { rounds, sortedByDate, currentRound, ts: Date.now() };
  leagueRoundsCache.set(cacheKey, result);
  return result;
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
    id:          e.id,
    homeTeam:    e.homeTeam?.name || '?',
    awayTeam:    e.awayTeam?.name || '?',
    homeTeamId:  e.homeTeam?.id || null,
    awayTeamId:  e.awayTeam?.id || null,
    homeLogo:    e.homeTeam?.id ? `https://api.sofascore.app/api/v1/team/${e.homeTeam.id}/image` : null,
    awayLogo:    e.awayTeam?.id ? `https://api.sofascore.app/api/v1/team/${e.awayTeam.id}/image` : null,
    startTime:   d ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '--:--',
    startDate:   d ? d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'Europe/Paris' }) : 'TBD',
    status:      mapEventStatus(e.status?.type),
    score:       (e.homeScore?.current != null && e.awayScore?.current != null)
                   ? { home: e.homeScore.current, away: e.awayScore.current }
                   : null,
    tournament:  e.tournament?.name || '',
  };
}

const computeStatsCache = new Map(); // `${competition}` → {data, ts}

// ─── /api/team-stats ─────────────────────────────────────
const teamStatsCache = new Map(); // `team-stats:${sport}:${teamId}` → {data, ts}
const TEAM_STATS_TTL = 12 * 3_600_000; // 12h

async function getTeamStats(sport, teamId, KEY) {
  const cacheKey = `team-stats:${sport}:${teamId}`;
  const cached = teamStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TEAM_STATS_TTL) return cached.data;

  const hdr = { 'x-rapidapi-host': SPORT_HOST, 'x-rapidapi-key': KEY };
  const base = `${SPORT_BASE}/api/v1/team/${teamId}`;

  // Fetch 1 : derniers matchs
  const eventsRes = await fetch(`${base}/events/last/0`, { headers: hdr, signal: AbortSignal.timeout(8000) });
  if (!eventsRes.ok) {
    const status = eventsRes.status;
    if (cached) return cached.data; // fallback cache périmé
    throw Object.assign(new Error('Upstream API error'), { status });
  }
  const eventsJson = await eventsRes.json();
  console.log(`[team-stats] fetched last events for team ${teamId} (sport=${sport})`);

  // 5 derniers matchs terminés (status.code === 100)
  const finished = (eventsJson.events || [])
    .filter(e => e.status?.code === 100)
    .sort((a, b) => (b.startTimestamp || 0) - (a.startTimestamp || 0))
    .slice(0, 5);

  const form = finished.map(e => {
    const isHome = Number(e.homeTeam?.id) === Number(teamId);
    const hs = e.homeScore?.current ?? 0;
    const as = e.awayScore?.current ?? 0;
    if (isHome) return hs > as ? 'W' : hs === as ? 'D' : 'L';
    return as > hs ? 'W' : as === hs ? 'D' : 'L';
  });

  const formScores = finished.map(e => ({
    homeTeam:  e.homeTeam?.name || '?',
    awayTeam:  e.awayTeam?.name || '?',
    homeScore: e.homeScore?.current ?? null,
    awayScore: e.awayScore?.current ?? null,
    date:      e.startTimestamp ? new Date(e.startTimestamp * 1000)
                 .toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', timeZone: 'Europe/Paris' }) : '',
  }));

  // Fetch 2 : stats saison (fallback sur /performance)
  let statsJson = null;
  const statsRes = await fetch(`${base}/statistics/overall`, { headers: hdr, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (statsRes?.ok) {
    statsJson = await statsRes.json();
    console.log(`[team-stats] fetched season stats for team ${teamId}`);
  } else {
    const perfRes = await fetch(`${base}/performance`, { headers: hdr, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (perfRes?.ok) { statsJson = await perfRes.json(); console.log(`[team-stats] fetched performance for team ${teamId}`); }
  }

  // Extraire moyennes depuis le JSON Sofascore
  const s = statsJson?.statistics || statsJson?.performance || null;
  const mp  = s?.matchesPlayed           || finished.length || 1;
  const gf  = s?.goals                  ?? finished.reduce((acc, e) => {
    const isHome = Number(e.homeTeam?.id) === Number(teamId);
    return acc + (isHome ? (e.homeScore?.current ?? 0) : (e.awayScore?.current ?? 0));
  }, 0);
  const ga  = s?.goalsConceded          ?? finished.reduce((acc, e) => {
    const isHome = Number(e.homeTeam?.id) === Number(teamId);
    return acc + (isHome ? (e.awayScore?.current ?? 0) : (e.homeScore?.current ?? 0));
  }, 0);

  const home5 = finished.filter(e => Number(e.homeTeam?.id) === Number(teamId));
  const away5 = finished.filter(e => Number(e.awayTeam?.id) === Number(teamId));
  const avgGoals = (arr, getG) => arr.length ? parseFloat((arr.reduce((s, e) => s + getG(e), 0) / arr.length).toFixed(2)) : null;

  const data = {
    teamId:    Number(teamId),
    teamName:  finished[0]?.homeTeam?.id == teamId ? finished[0]?.homeTeam?.name : finished[0]?.awayTeam?.name || String(teamId),
    form,
    formScores,
    seasonStats: {
      matchesPlayed:          mp,
      goalsScoredAvg:         parseFloat((gf / mp).toFixed(2)),
      goalsConcededAvg:       parseFloat((ga / mp).toFixed(2)),
      goalsScoredHomeAvg:     avgGoals(home5, e => e.homeScore?.current ?? 0),
      goalsConcededHomeAvg:   avgGoals(home5, e => e.awayScore?.current ?? 0),
      goalsScoredAwayAvg:     avgGoals(away5, e => e.awayScore?.current ?? 0),
      goalsConcededAwayAvg:   avgGoals(away5, e => e.homeScore?.current ?? 0),
      cleanSheetsPercent:     finished.length
        ? Math.round(finished.filter(e => {
            const isHome = Number(e.homeTeam?.id) === Number(teamId);
            return isHome ? (e.awayScore?.current ?? 1) === 0 : (e.homeScore?.current ?? 1) === 0;
          }).length / finished.length * 100)
        : 0,
    },
    lastUpdated: new Date().toISOString(),
  };

  teamStatsCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

app.get('/api/team-stats', async (req, res) => {
  const { teamId, sport = 'football' } = req.query;
  if (!teamId || !/^\d+$/.test(teamId)) return res.status(400).json({ error: 'Invalid teamId or sport' });

  const KEY = process.env.RAPIDAPI_KEY;
  if (!KEY) return res.status(500).json({ error: 'RAPIDAPI_KEY not configured' });

  try {
    const data = await getTeamStats(sport, teamId, KEY);
    res.json(data);
  } catch (err) {
    if (err.name === 'TimeoutError') return res.status(504).json({ error: 'Upstream timeout' });
    const status = err.status;
    if (status === 404 || status === 429) return res.status(502).json({ error: 'Upstream API error' });
    res.status(500).json({ error: err.message });
  }
});

const COMPUTE_STATS_TTL = 6 * 3_600_000; // 6h
const LIGUE_AVG_GOALS_CONCEDED = 1.2;

app.get('/api/compute-stats', async (req, res) => {
  const { competition, matchId, homeTeamId, awayTeamId } = req.query;

  const cacheKey = matchId ? `match:${matchId}` : `league:${competition || ''}`;
  const cached = computeStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < COMPUTE_STATS_TTL) return res.json(cached.data);

  const KEY = process.env.RAPIDAPI_KEY;
  let lH, lA, lambdaSource, homeForm, awayForm;

  if (homeTeamId && awayTeamId && KEY) {
    try {
      const [homeStats, awayStats] = await Promise.all([
        getTeamStats('football', homeTeamId, KEY),
        getTeamStats('football', awayTeamId, KEY),
      ]);

      const hScored  = homeStats.seasonStats.goalsScoredHomeAvg  ?? homeStats.seasonStats.goalsScoredAvg;
      const aConceded = awayStats.seasonStats.goalsConcededAwayAvg ?? awayStats.seasonStats.goalsConcededAvg;
      const aScored  = awayStats.seasonStats.goalsScoredAwayAvg  ?? awayStats.seasonStats.goalsScoredAvg;
      const hConceded = homeStats.seasonStats.goalsConcededHomeAvg ?? homeStats.seasonStats.goalsConcededAvg;

      lH = Math.max(0.3, parseFloat((hScored  * (aConceded / LIGUE_AVG_GOALS_CONCEDED)).toFixed(3)));
      lA = Math.max(0.3, parseFloat((aScored  * (hConceded / LIGUE_AVG_GOALS_CONCEDED)).toFixed(3)));
      lambdaSource = 'team-based';
      homeForm = homeStats.form;
      awayForm = awayStats.form;
    } catch (err) {
      console.warn('[compute-stats] team-stats fallback:', err.message);
      // fall through to league default
    }
  }

  if (!lambdaSource) {
    const league = Object.values(LEAGUES).find(l =>
      competition && l.name.toLowerCase() === competition.toLowerCase()
    );
    lH = league?.lH ?? 1.35;
    lA = league?.lA ?? 1.05;
    lambdaSource = 'league-default';
  }

  const s = matchScore(lH, lA);
  const data = {
    btts:         s.btts,
    over25:       s.over25,
    over15:       s.over15 ?? Math.round(Math.min(95, s.over25 * 1.25)),
    homeWin:      s.homeWin,
    draw:         s.draw,
    awayWin:      s.awayWin,
    confidence:   s.confidence,
    goalsHome:    parseFloat(lH.toFixed(2)),
    goalsAway:    parseFloat(lA.toFixed(2)),
    lambdaSource,
    ...(homeForm !== undefined && { homeForm, awayForm }),
  };

  if (lambdaSource === 'team-based') computeStatsCache.set(cacheKey, { data, ts: Date.now() });
  res.json(data);
});

// ─── /api/h2h ─────────────────────────────────────────────
const h2hCache = new Map();
const H2H_TTL       = 7 * 24 * 3_600_000;
const H2H_EMPTY_TTL = 10 * 60_000;

app.get('/api/h2h', async (req, res) => {
  const { eventId, team1Id, team2Id, sport = 'football' } = req.query;
  if (!eventId || !/^\d+$/.test(eventId))
    return res.status(400).json({ error: 'Invalid eventId' });

  const KEY = process.env.RAPIDAPI_KEY;
  if (!KEY) return res.status(500).json({ error: 'RAPIDAPI_KEY not configured' });

  const cacheKey = `h2h:${sport}:${eventId}`;
  const cached = h2hCache.get(cacheKey);
  if (cached) {
    const ttl = cached.data.totalMatches > 0 ? H2H_TTL : H2H_EMPTY_TTL;
    if (Date.now() - cached.ts < ttl) return res.json(cached.data);
  }

  const hdr = { 'x-rapidapi-host': SPORT_HOST, 'x-rapidapi-key': KEY };
  const empty = { matches: [], totalMatches: 0, balance: { team1Wins: 0, draws: 0, team2Wins: 0 }, lastUpdated: new Date().toISOString() };

  console.log(`[H2H] Fetching eventId=${eventId} team1Id=${team1Id||'?'} team2Id=${team2Id||'?'}`);

  const buildMatches = (allEvents, refT1Id) => {
    const events = allEvents
      .filter(e => e.status?.code === 100)
      .sort((a, b) => (b.startTimestamp || 0) - (a.startTimestamp || 0))
      .slice(0, 5);
    let team1Wins = 0, draws = 0, team2Wins = 0;
    const matches = events.map(e => {
      const isTeam1Home = Number(e.homeTeam?.id) === Number(refT1Id);
      const hs = e.homeScore?.current ?? 0;
      const as = e.awayScore?.current ?? 0;
      if (hs === as) draws++;
      else if (isTeam1Home ? hs > as : as > hs) team1Wins++;
      else team2Wins++;
      const d = e.startTimestamp ? new Date(e.startTimestamp * 1000) : null;
      return {
        date: d ? d.toISOString() : null,
        dateFormatted: d ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/Paris' }) : '',
        homeTeam:    e.homeTeam?.name || '?',
        awayTeam:    e.awayTeam?.name || '?',
        homeTeamId:  Number(e.homeTeam?.id) || null,
        awayTeamId:  Number(e.awayTeam?.id) || null,
        homeScore:   hs,
        awayScore:   as,
        competition: e.tournament?.name || '',
      };
    });
    return { matches, balance: { team1Wins, draws, team2Wins } };
  };

  try {
    // Stratégie 1 : endpoint H2H direct
    const r = await fetch(`${SPORT_BASE}/api/v1/event/${eventId}/h2h`, { headers: hdr, signal: AbortSignal.timeout(8000) });
    console.log(`[H2H] Direct endpoint status: ${r.status}`);

    if (r.ok) {
      const json = await r.json();
      const keys = Object.keys(json).join(', ');
      const allEvents = json.previousEvents || json.events || [];
      console.log(`[H2H] Response keys: ${keys} | raw events: ${allEvents.length}`);

      if (allEvents.length > 0) {
        const refT1Id = team1Id || (allEvents[0] ? allEvents[0].homeTeam?.id : null);
        const { matches, balance } = buildMatches(allEvents, refT1Id);
        console.log(`[H2H] Returning ${matches.length} matches (direct)`);
        const data = { matches, totalMatches: matches.length, balance, lastUpdated: new Date().toISOString() };
        h2hCache.set(cacheKey, { data, ts: Date.now() });
        return res.json(data);
      }
      console.warn(`[H2H] Direct endpoint returned 200 but no events. Keys: ${keys}`);
    } else {
      const errBody = await r.text().catch(() => '');
      console.warn(`[H2H] Direct endpoint failed: ${r.status} — ${errBody.slice(0, 200)}`);
    }

    // Stratégie 2 : fallback via derniers matchs de team1 filtrés sur team2
    if (!team1Id || !team2Id) {
      console.warn('[H2H] Fallback impossible: team1Id ou team2Id manquant');
      if (cached) return res.json(cached.data);
      return res.json(empty);
    }

    console.log(`[H2H] Fallback: fetching last events for team1Id=${team1Id}`);
    const r2 = await fetch(`${SPORT_BASE}/api/v1/team/${team1Id}/events/last/0`, { headers: hdr, signal: AbortSignal.timeout(8000) });
    console.log(`[H2H] Fallback team events status: ${r2.status}`);

    if (!r2.ok) {
      if (cached) return res.json(cached.data);
      return res.json(empty);
    }

    const json2 = await r2.json();
    const teamEvents = json2.events || [];
    const h2hEvents = teamEvents.filter(e =>
      Number(e.homeTeam?.id) === Number(team2Id) || Number(e.awayTeam?.id) === Number(team2Id)
    );
    console.log(`[H2H] Fallback: team events total=${teamEvents.length}, vs team2=${h2hEvents.length}`);

    const { matches, balance } = buildMatches(h2hEvents, team1Id);
    console.log(`[H2H] Returning ${matches.length} matches (fallback)`);
    const data = { matches, totalMatches: matches.length, balance, lastUpdated: new Date().toISOString() };
    h2hCache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);

  } catch (err) {
    console.error('[H2H] ERROR:', err.message);
    if (cached) return res.json(cached.data);
    if (err.name === 'TimeoutError') return res.status(504).json({ error: 'Upstream timeout' });
    res.status(502).json({ error: 'Upstream error' });
  }
});

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
    const { rounds, sortedByDate, currentRound } = await getLeagueRounds(sport, tournament, KEY);

    if (!sortedByDate.length || currentRound == null)
      return res.json({ journee: 0, matches: [], journeeInfo: { current: 0, previous: 0, next: 0 } });

    // Navigation par date chronologique, pas par numéro de journée
    const currentIdx    = sortedByDate.indexOf(currentRound);
    const previousRound = currentIdx > 0 ? sortedByDate[currentIdx - 1] : null;
    const nextRound     = currentIdx < sortedByDate.length - 1 ? sortedByDate[currentIdx + 1] : null;
    const targetRound   = { current: currentRound, previous: previousRound, next: nextRound }[journee];

    if (targetRound == null)
      return res.json({
        journee: 0, matches: [],
        journeeInfo: { current: currentRound, previous: previousRound ?? 0, next: nextRound ?? 0 },
      });

    // Pour "current" : tous les matchs d'aujourd'hui (live, terminés, à venir) + futurs
    const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    const matches = (rounds.get(targetRound) || [])
      .filter(e => journee !== 'current' || (e.startTimestamp || 0) >= todayStart)
      .sort((a, b) => (a.startTimestamp || 0) - (b.startTimestamp || 0))
      .map(mapEventToMatch);

    const result = {
      journee: targetRound,
      matches,
      journeeInfo: {
        current:  currentRound,
        previous: previousRound ?? currentRound - 1,
        next:     nextRound     ?? currentRound + 1,
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
computeStatsCache.clear();
app.listen(PORT, () => {
  console.log(`BetVision AI démarré sur le port ${PORT}`);
});
