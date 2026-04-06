export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const league = req.query.league || 'PL';
  
  const leagueMap = {
    'PL': '47', 'FL1': '53', 'PD': '87',
    'SA': '55', 'BL1': '54', 'CL': '42'
  };
  
  const leagueId = leagueMap[league] || '47';

  try {
    const response = await fetch(
      `https://free-api-live-football-data.p.rapidapi.com/football-get-all-matches-by-league?leagueid=${leagueId}`,
      {
        headers: {
          'x-rapidapi-host': 'free-api-live-football-data.p.rapidapi.com',
          'x-rapidapi-key': '47025106d4msh3f5ff29ba28372ap1938b7jsnd189477d3b6a'
        }
      }
    );
    const data = await response.json();
    
    const raw = data?.response?.matches || data?.response || [];
    
    const matches = raw.map((item, idx) => {
      const home = item.home?.name || item.homeTeam?.name || 'Équipe A';
      const away = item.away?.name || item.awayTeam?.name || 'Équipe B';
      const dateRaw = item.utcTime || item.date || '';
      const dateObj = dateRaw ? new Date(dateRaw) : new Date();
      const dateStr = dateObj.toLocaleDateString('fr-FR', { weekday:'short', day:'2-digit', month:'short' });
      const timeStr = dateObj.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Paris' });
      
      return {
        id: idx,
        home, away,
        date: dateStr,
        time: timeStr,
        btts: Math.floor(50 + Math.random() * 35),
        over25: Math.floor(45 + Math.random() * 35),
        over15: Math.floor(65 + Math.random() * 25),
        confidence: Math.floor(55 + Math.random() * 35),
        formHome: ['W','D','W','L','W'],
        formAway: ['W','W','D','W','L'],
        goalsHome: +(1.2 + Math.random()).toFixed(1),
        goalsAway: +(1.0 + Math.random()).toFixed(1),
        cleanHome: +(Math.random() * 0.6).toFixed(1),
        cleanAway: +(Math.random() * 0.6).toFixed(1),
      };
    });

    res.status(200).json({ matches });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
