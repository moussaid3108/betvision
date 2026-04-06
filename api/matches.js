export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const league = req.query.league || 'PL';
  
  const leagueMap = {
    'PL': '152', 'FL1': '168', 'PD': '302',
    'SA': '207', 'BL1': '175', 'CL': '181'
  };
  
  const leagueId = leagueMap[league] || '152';

  try {
    const response = await fetch(
      `https://free-api-live-football-data.p.rapidapi.com/football-get-matches-by-league?leagueid=${leagueId}`,
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
