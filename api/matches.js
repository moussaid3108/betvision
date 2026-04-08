// ─── Poisson distribution helpers ───
function poissonProb(lambda, k) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return Math.pow(lambda, k) * Math.exp(-lambda) / fact;
}

function calcMatchStats(lambdaHome, lambdaAway) {
  const MAX = 8;
  let homeWin = 0, draw = 0, awayWin = 0, over25 = 0, over15 = 0;

  for (let h = 0; h <= MAX; h++) {
    const ph = poissonProb(lambdaHome, h);
    for (let a = 0; a <= MAX; a++) {
      const pa = poissonProb(lambdaAway, a);
      const p = ph * pa;
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
      if (h + a > 2.5) over25 += p;
      if (h + a > 1.5) over15 += p;
    }
  }

  const p0h = Math.exp(-lambdaHome);
  const p0a = Math.exp(-lambdaAway);
  const btts = (1 - p0h) * (1 - p0a);

  return {
    homeWin: Math.round(homeWin * 100),
    draw:    Math.round(draw    * 100),
    awayWin: Math.round(awayWin * 100),
    btts:    Math.round(btts    * 100),
    over25:  Math.round(over25  * 100),
    over15:  Math.round(over15  * 100),
  };
}

function formToArray(str) {
  return (str || 'WDWLW').slice(-5).split('').map(c => c.toUpperCase());
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

// ─── Vercel Handler ───
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const league  = req.query.league || 'PL';
  const KEY     = process.env.RAPIDAPI_KEY || '47025106d4msh3f5ff29ba28372ap1938b7jsnd189477d3b6a';
  const HOST    = 'api-football-v1.p.rapidapi.com';
  const SEASON  = '2025';

  const leagueMap = { PL: 39, FL1: 61, PD: 140, SA: 135, BL1: 78, CL: 2 };
  const leagueId  = leagueMap[league] || 39;

  const apiFetch = (path) =>
    fetch(`https://${HOST}${path}`, {
      headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY }
    });

  try {
    // 2 calls in parallel: upcoming fixtures + standings
    const [fRes, sRes] = await Promise.all([
      apiFetch(`/fixtures?league=${leagueId}&season=${SEASON}&next=10&timezone=Europe/Paris`),
      apiFetch(`/standings?league=${leagueId}&season=${SEASON}`)
    ]);

    if (!fRes.ok) throw new Error(`Fixtures API error: ${fRes.status}`);
    const [fData, sData] = await Promise.all([fRes.json(), sRes.json()]);

    // Build team stats lookup (flattens CL group stage too)
    const teamStats = {};
    const groups = sData?.response?.[0]?.league?.standings || [];
    groups.flat().forEach(entry => {
      if (entry?.team?.id) teamStats[entry.team.id] = entry;
    });

    const fixtures = fData?.response || [];

    const matches = fixtures.map((item, idx) => {
      const fixture = item.fixture || {};
      const teams   = item.teams  || {};
      const homeId  = teams.home?.id;
      const awayId  = teams.away?.id;
      const homeEntry = teamStats[homeId] || {};
      const awayEntry = teamStats[awayId] || {};

      // Home team attack (home games) vs away team defence (away games)
      const hH  = homeEntry.home || {};
      const aA  = awayEntry.away || {};
      const hGF = hH.goals?.for      ?? 0;
      const hGA = hH.goals?.against  ?? 0;
      const hP  = hH.played || 1;
      const aGF = aA.goals?.for      ?? 0;
      const aGA = aA.goals?.against  ?? 0;
      const aP  = aA.played || 1;

      // Expected goals (Poisson lambda) — blend own attack + opponent defence
      const lambdaHome = Math.max(0.4, (hGF / hP + aGA / aP) / 2);
      const lambdaAway = Math.max(0.3, (aGF / aP + hGA / hP) / 2);

      const stats = calcMatchStats(lambdaHome, lambdaAway);

      const formHome = formToArray(homeEntry.form);
      const formAway = formToArray(awayEntry.form);
      const formScore = formHome.filter(x => x === 'W').length +
                        formAway.filter(x => x === 'W').length;

      const confidence = clamp(
        Math.round(stats.btts * 0.25 + stats.over25 * 0.25 + formScore * 4 + 8),
        42, 93
      );

      // Clean-sheet probability via Poisson P(goals=0)
      const cleanHome = +Math.exp(-(hGA / hP)).toFixed(2);
      const cleanAway = +Math.exp(-(aGA / aP)).toFixed(2);

      const d = new Date(fixture.date || '');
      const dateStr = isNaN(d) ? 'TBD' :
        d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' });
      const timeStr = isNaN(d) ? '--:--' :
        d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

      return {
        id:          fixture.id || idx,
        home:        teams.home?.name || 'Équipe A',
        away:        teams.away?.name || 'Équipe B',
        date:        dateStr,
        time:        timeStr,
        competition: item.league?.name || league,
        venue:       fixture.venue?.name || '',
        btts:        clamp(stats.btts,    20, 90),
        over25:      clamp(stats.over25,  15, 90),
        over15:      clamp(stats.over15,  30, 95),
        homeWin:     clamp(stats.homeWin, 10, 85),
        draw:        clamp(stats.draw,    10, 40),
        awayWin:     clamp(stats.awayWin, 10, 85),
        confidence,
        formHome,
        formAway,
        goalsHome:   +lambdaHome.toFixed(1),
        goalsAway:   +lambdaAway.toFixed(1),
        cleanHome,
        cleanAway,
      };
    });

    res.status(200).json({ matches, source: 'api-football', season: SEASON });
  } catch (e) {
    res.status(500).json({ error: e.message, matches: [] });
  }
}
