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
