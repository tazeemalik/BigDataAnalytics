// Containers/monitortool/index.js
const express = require('express');
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://dbstorage:27017';
const DBNAME = process.env.DBNAME || 'cloneDetector';
const SAMPLE_INTERVAL_MS = parseInt(process.env.SAMPLE_INTERVAL_MS || '5000'); // sample every 5s
const PORT = parseInt(process.env.PORT || '4000');

async function main() {
  const client = new MongoClient(MONGO_URL, { useUnifiedTopology: true });
  await client.connect();
  console.log(`MonitorTool connected to ${MONGO_URL} db ${DBNAME}`);
  const db = client.db(DBNAME);
  const samplesColl = db.collection('monitorSamples');

  // ensure small TTL index maybe or at least an index on ts
  samplesColl.createIndex({ ts: 1 }).catch(() => {});

  const app = express();

  // Serve UI on root (with correct content-type)
  app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>MonitorTool - cljDetector</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 16px; }
    .row { display:flex; gap:16px; align-items:flex-start; }
    #chart { width: 70%; }
    #status { width:30%; max-height:600px; overflow:auto; background:#f5f5f5; padding:8px; border-radius:6px; }
    table { border-collapse: collapse; width:100% }
    td, th { padding:6px; border:1px solid #ddd; }
  </style>
</head>
<body>
<h1>MonitorTool - cljDetector</h1>
<div class="row">
  <div id="chart">
    <canvas id="myChart"></canvas>
  </div>
  <div id="status">
    <h3>Status updates</h3>
    <div id="updates"></div>
  </div>
</div>

<script>
async function fetchData() {
  const [samplesRes, statusRes] = await Promise.all([
    fetch('/api/samples'),
    fetch('/api/status?limit=30')
  ]);
  const samples = await samplesRes.json();
  const status = await statusRes.json();
  return { samples, status };
}

function renderStatus(status) {
  const updates = document.getElementById('updates');
  updates.innerHTML = '';
  status.forEach(s => {
    const d = new Date(s.ts).toISOString();
    const div = document.createElement('div');
    div.style.marginBottom = '8px';
    div.innerHTML = '<b>' + d + '</b><div>' + (s.msg||'') + '</div>';
    updates.appendChild(div);
  });
}

function renderChart(samples) {
  const ctx = document.getElementById('myChart').getContext('2d');
  const labels = samples.map(s => new Date(s.ts).toLocaleTimeString());
  const files = samples.map(s => s.files);
  const chunks = samples.map(s => s.chunks);
  const candidates = samples.map(s => s.candidates);
  const clones = samples.map(s => s.clones);
  if (window._chartInstance) window._chartInstance.destroy();
  window._chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'files', data: files, fill:false },
        { label: 'chunks', data: chunks, fill:false },
        { label: 'candidates', data: candidates, fill:false },
        { label: 'clones', data: clones, fill:false }
      ]
    }
  });
}

async function refresh() {
  const { samples, status } = await fetchData();
  renderChart(samples);
  renderStatus(status);
}

setInterval(refresh, 3000);
refresh();
</script>
</body>
</html>
`);
  });

  // API to return stored samples (descending by ts)
  app.get('/api/samples', async (req, res) => {
    const docs = await samplesColl.find({}).sort({ ts: 1 }).limit(1000).toArray();
    res.json(docs);
  });

  // API to return the latest status updates (from statusUpdates collection)
  app.get('/api/status', async (req, res) => {
    const limit = parseInt(req.query.limit || '50');
    const col = db.collection('statusUpdates');
    const docs = await col.find({}).sort({ ts: -1 }).limit(limit).toArray();
    res.json(docs);
  });

  // Start sampling loop: sample counts and store in monitorSamples
  setInterval(async () => {
    try {
      const files = await db.collection('files').countDocuments();
      const chunks = await db.collection('chunks').countDocuments();
      const candidates = await db.collection('candidates').countDocuments();
      const clones = await db.collection('clones').countDocuments();
      const ts = Date.now();
      const sample = { ts, files, chunks, candidates, clones };
      await samplesColl.insertOne(sample);
      // keep samples collection small (optional): delete older than a day or keep last N
      // await samplesColl.deleteMany({ ts: { $lt: ts - 1000*60*60*24 } });
      console.log(new Date().toISOString(), `files=${files} chunks=${chunks} candidates=${candidates} clones=${clones}`);
    } catch (err) {
      console.error('sampling error', err);
    }
  }, SAMPLE_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`MonitorTool UI listening on :${PORT}`);
  });
}

main().catch(err => {
  console.error('MonitorTool failed to start', err);
  process.exit(1);
});
