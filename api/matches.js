export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const league = req.query.league || 'PL';
  
  const leagueMap = {
    'PL': '47',
    'FL1': '53',
    'PD': '87',
    'SA': '55',
    'BL1': '54',
    'CL': '42'
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
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
