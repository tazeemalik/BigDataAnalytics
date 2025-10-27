// server.js
const express = require('express');
const { MongoClient } = require('mongodb');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://dbstorage:27017';
const DBNAME = process.env.DBNAME || 'cloneDetector';
const SAMPLE_INTERVAL_MS = parseInt(process.env.SAMPLE_INTERVAL_MS || '5000', 10); // 5s default
const SAMPLES_COLLECTION = 'monitor_samples';

let client;
let db;

// static frontend
app.use('/', express.static(path.join(__dirname, 'public')));

// helper: connect
async function connect() {
  client = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await client.connect();
  db = client.db(DBNAME);
  console.log(`MonitorTool connected to ${MONGO_URI} db ${DBNAME}`);
}

// periodic sampler
async function sampleOnce() {
  try {
    const files = await db.collection('files').countDocuments();
    const chunks = await db.collection('chunks').countDocuments();
    const candidates = await db.collection('candidates').countDocuments();
    const clones = await db.collection('clones').countDocuments();

    const sample = {
      ts: new Date(),
      files, chunks, candidates, clones
    };

    await db.collection(SAMPLES_COLLECTION).insertOne(sample);

    // optionally keep recent history bounded (e.g. keep last 10000 samples)
    // await db.collection(SAMPLES_COLLECTION).deleteMany({ ... });
    console.log(new Date().toISOString(), `files=${files} chunks=${chunks} candidates=${candidates} clones=${clones}`);
  } catch (e) {
    console.error('Sample error', e);
  }
}

let samplerInterval = null;
async function startSampler() {
  // ensure collection exists
  await db.collection(SAMPLES_COLLECTION).createIndex({ ts: 1 });
  // take initial sample immediately
  await sampleOnce();
  samplerInterval = setInterval(sampleOnce, SAMPLE_INTERVAL_MS);
}

// API: get samples
app.get('/api/samples', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '200', 10);
    const cursor = db.collection(SAMPLES_COLLECTION).find().sort({ ts: 1 }).limit(limit);
    const samples = await cursor.toArray();
    res.json(samples);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.toString() });
  }
});

// API: get status updates (from statusUpdates collection)
app.get('/api/status', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const updates = await db.collection('statusUpdates').find().sort({ ts: -1 }).limit(limit).toArray();
    res.json(updates);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.toString() });
  }
});

// API: summary / computed processing times from statusUpdates
app.get('/api/summary', async (req, res) => {
  try {
    const counts = {
      files: await db.collection('files').countDocuments(),
      chunks: await db.collection('chunks').countDocuments(),
      candidates: await db.collection('candidates').countDocuments(),
      clones: await db.collection('clones').countDocuments(),
      statusUpdates: await db.collection('statusUpdates').countDocuments()
    };

    // fetch all statusUpdates (or last 500) in chronological order
    const updates = await db.collection('statusUpdates').find().sort({ ts: 1 }).limit(1000).toArray();

    // helper to find first update whose message contains a substring
    const findTsContaining = (substr) => {
      const u = updates.find(x => x.message && x.message.toLowerCase().includes(substr.toLowerCase()));
      return u ? new Date(u.ts) : null;
    };

    // Look for key milestones - adapt strings if your ts-println messages differ
    const t_reading = findTsContaining('reading and processing files');
    const t_store_files = findTsContaining('storing files');
    const t_store_chunks = findTsContaining('storing chunks');
    const t_identify_candidates = findTsContaining('identifying clone candidates');
    const t_found_candidates = findTsContaining('found') || findTsContaining('found') ;
    const t_expanding = findTsContaining('expanding candidates');
    const t_storing_clones = findTsContaining('storing clones');
    const t_summary = findTsContaining('summary');

    function diffMin(a, b) {
      if (!a || !b) return null;
      return Math.round(((b - a) / 1000) / 60); // minutes approx
    }
    function diffHMS(a,b){
      if(!a||!b) return null;
      const s = Math.round((b-a)/1000);
      const hh = Math.floor(s/3600); const mm = Math.floor((s%3600)/60); const ss = s%60;
      return `${hh}h ${mm}m ${ss}s`;
    }

    const processingSummary = [
      { step: 'Reading and Processing Files', collection: '-', items: '-', time: diffMin(t_reading, t_store_files) ? `${diffMin(t_reading, t_store_files)} min` : '-' },
      { step: 'Storing Files', collection: 'files', items: counts.files, time: t_store_files && t_store_chunks ? diffHMS(t_store_files, t_store_chunks) || '-' : '-' },
      { step: 'Storing Chunks', collection: 'chunks', items: counts.chunks, time: t_store_chunks && t_identify_candidates ? diffHMS(t_store_chunks, t_identify_candidates) || '-' : '-' },
      { step: 'Identifying Clone Candidates', collection: 'candidates', items: (t_found_candidates && typeof t_found_candidates !== 'undefined') ? '≈ ' + (await db.collection('candidates').countDocuments()) : '-', time: t_identify_candidates && t_found_candidates ? diffHMS(t_identify_candidates, t_found_candidates) : '-' },
      { step: 'Expanding Candidates', collection: '-', items: '-', time: t_expanding && t_storing_clones ? diffHMS(t_expanding, t_storing_clones) : '-' },
      { step: 'Storing Clones', collection: 'clones', items: counts.clones, time: t_storing_clones && t_summary ? diffHMS(t_storing_clones, t_summary) : '-' }
    ];

    res.json({ counts, processingSummary, rawStatus: updates.slice(-50) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.toString() });
  }
});

// start server & connect
(async () => {
  try {
    await connect();
    await startSampler();
    app.listen(PORT, () => {
      console.log(`MonitorTool UI listening on :${PORT}`);
    });
  } catch (e) {
    console.error('Startup error', e);
    process.exit(1);
  }
})();

// graceful shutdown
process.on('SIGINT', () => {
  if (samplerInterval) clearInterval(samplerInterval);
  if (client) client.close(false).then(() => process.exit(0));
  else process.exit(0);
});
