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

// ─── helpers Poisson (dupliqués pour /api/today) ──────────
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

app.get('/api/today', async (req, res) => {
  const KEY    = process.env.RAPIDAPI_KEY || '47025106d4msh3f5ff29ba28372ap1938b7jsnd189477d3b6a';
  const HOST   = 'api-football-v1.p.rapidapi.com';
  const SEASON = '2025';
  const LEAGUES = { 39: 'Premier League', 61: 'Ligue 1', 140: 'La Liga', 135: 'Serie A', 78: 'Bundesliga', 2: 'Champions League' };
  const today  = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const hdr    = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };
  const apiFetch = p => fetch(`https://${HOST}${p}`, { headers: hdr });

  try {
    // 1. Fixtures du jour pour chaque ligue majeure (en parallèle)
    const fixtureResponses = await Promise.all(
      Object.keys(LEAGUES).map(id =>
        apiFetch(`/fixtures?league=${id}&season=${SEASON}&date=${today}&timezone=Europe/Paris`).then(r => r.json())
      )
    );

    // 2. Collecter les fixtures + leagues uniques
    const allFixtures = [];
    const leagueIds   = new Set();
    fixtureResponses.forEach(data => {
      (data?.response || []).forEach(f => {
        allFixtures.push(f);
        leagueIds.add(f.league?.id);
      });
    });

    if (!allFixtures.length) return res.json({ matches: [] });

    // 3. Standings pour calculer lambdas (en parallèle)
    const standingsData = await Promise.all(
      [...leagueIds].map(id =>
        apiFetch(`/standings?league=${id}&season=${SEASON}`).then(r => r.json())
      )
    );
    const teamStats = {};
    standingsData.forEach(sd => {
      const groups = sd?.response?.[0]?.league?.standings || [];
      groups.flat().forEach(e => { if (e?.team?.id) teamStats[e.team.id] = e; });
    });

    // 4. Calcul Poisson + tri
    const matches = allFixtures.map((item, idx) => {
      const fix  = item.fixture || {};
      const teams = item.teams  || {};
      const hId  = teams.home?.id, aId = teams.away?.id;
      const hE   = teamStats[hId]?.home || {};
      const aE   = teamStats[aId]?.away || {};
      const hP   = hE.played || 1, aP = aE.played || 1;
      const lH   = Math.max(0.5, ((hE.goals?.for ?? 1.4) / hP + (aE.goals?.against ?? 1.1) / aP) / 2);
      const lA   = Math.max(0.3, ((aE.goals?.for ?? 1.0) / aP + (hE.goals?.against ?? 1.1) / hP) / 2);
      const stats = matchScore(lH, lA);
      const d = new Date(fix.date || '');
      return {
        id:          fix.id || idx,
        home:        teams.home?.name || '?',
        away:        teams.away?.name || '?',
        competition: item.league?.name || LEAGUES[item.league?.id] || 'Ligue',
        time:        isNaN(d) ? '--:--' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        date:        isNaN(d) ? 'Aujourd\'hui' : d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' }),
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
  const KEY  = process.env.RAPIDAPI_KEY || '47025106d4msh3f5ff29ba28372ap1938b7jsnd189477d3b6a';
  const HOST = 'api-football-v1.p.rapidapi.com';
  try {
    const r = await fetch(`https://${HOST}/fixtures?id=${id}`, {
      headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY }
    });
    const data = await r.json();
    const f = data?.response?.[0];
    if (!f) return res.json({ status: null });
    res.json({
      status:     f.fixture?.status?.short,
      homeGoals:  f.goals?.home,
      awayGoals:  f.goals?.away,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
