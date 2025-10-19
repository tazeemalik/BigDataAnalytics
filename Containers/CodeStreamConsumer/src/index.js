const express = require('express');
const formidable = require('formidable');
const fs = require('fs/promises');
const app = express();
const PORT = 3000;

const Timer = require('./Timer');
const CloneDetector = require('./CloneDetector');
const CloneStorage = require('./CloneStorage');
const FileStorage = require('./FileStorage');

// ---- Timing history (new) ----
const statsHistory = [];
const MAX_SAMPLES = 5000; // keep last N files
function recordStatsSample(file) {
    try {
        const timers = Timer.getTimers(file);           // BigInt nanoseconds
        const total_us = Number(timers.total / 1000n);  // µs
        const match_us = Number(timers.match / 1000n);
        const loc = (file.contents.match(/\n/g) || []).length + 1;

        statsHistory.push({
            name: file.name,
            loc,
            total_us,
            match_us,
            us_per_loc: loc ? match_us / loc : 0
        });

        if (statsHistory.length > MAX_SAMPLES) statsHistory.shift();
    } catch (e) {
        console.error("Failed to record stats sample:", e.message);
    }
}

// Express and Formidable setup
// --------------------
const form = formidable({ multiples: false });

app.post('/', fileReceiver);
function fileReceiver(req, res, next) {
    form.parse(req, (err, fields, files) => {
        // 🩹 FIX #1 — guard for missing file data
        if (!files || !files.data || !files.data.filepath) {
            console.error("⚠️  Skipping upload: 'files.data.filepath' undefined");
            return res.end('');
        }

        fs.readFile(files.data.filepath, { encoding: 'utf8' })
            .then(data => processFile(fields.name, data))
            .catch(err => console.error("File read failed:", err.message));
    });
    return res.end('');
}

app.get('/', viewClones);

// 🆕 New endpoints for timing stats
app.get('/timers.json', (req, res) => {
    res.json({ samples: statsHistory });
});

app.get('/timers', (req, res) => {
    const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

    const totals = statsHistory.map(s => s.total_us);
    const matches = statsHistory.map(s => s.match_us);
    const norm = statsHistory.map(s => s.us_per_loc);

    // Build HTML response with Chart.js visualization
    let html = `
    <html>
    <head>
        <title>Timing Stats</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <style>
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding: 20px; background: #fafafa; }
            h1 { margin-bottom: 0; }
            p { margin-top: 4px; color: #555; }
            table { border-collapse: collapse; width: 100%; margin-top: 20px; }
            th, td { border: 1px solid #ddd; padding: 6px 8px; font-variant-numeric: tabular-nums; }
            th { background: #f5f5f5; text-align: left; }
            tr:nth-child(even) { background: #fdfdfd; }
            .chart-container { width: 100%; height: 400px; margin-top: 20px; background: #fff; border: 1px solid #ddd; padding: 10px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
            a { color: #007acc; text-decoration: none; }
        </style>
    </head>
    <body>
        <h1>Timing Statistics</h1>
        <p>
            Samples: ${statsHistory.length}
            &nbsp;|&nbsp; Avg total: ${avg(totals).toFixed(1)} µs
            &nbsp;|&nbsp; Avg match: ${avg(matches).toFixed(1)} µs
            &nbsp;|&nbsp; Avg match/LOC: ${avg(norm).toFixed(3)} µs/LOC
            &nbsp;|&nbsp; <a href="/timers.json">View JSON</a>
        </p>

        <div class="chart-container">
            <canvas id="timeChart"></canvas>
        </div>

        <script>
            // Prepare data
            const data = ${JSON.stringify(statsHistory.slice(-200))};
            const labels = data.map((s, i) => s.name.split('/').pop());
            const totals = data.map(s => s.total_us);
            const matches = data.map(s => s.match_us);
            const perLoc = data.map(s => s.us_per_loc);

            const ctx = document.getElementById('timeChart').getContext('2d');
            new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: 'Total time (µs)',
                            data: totals,
                            borderColor: 'rgba(75,192,192,1)',
                            fill: false,
                            tension: 0.1
                        },
                        {
                            label: 'Match time (µs)',
                            data: matches,
                            borderColor: 'rgba(255,99,132,1)',
                            fill: false,
                            tension: 0.1
                        },
                        {
                            label: 'Match/LOC (µs)',
                            data: perLoc,
                            borderColor: 'rgba(54,162,235,1)',
                            borderDash: [5,5],
                            fill: false,
                            tension: 0.1
                        }
                    ]
                },
                options: {
                    responsive: true,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { position: 'bottom' },
                        title: { display: true, text: 'Processing Time per File (latest 200 samples)' }
                    },
                    scales: {
                        x: { display: false },
                        y: {
                            beginAtZero: true,
                            title: { display: true, text: 'Time (µs)' }
                        }
                    }
                }
            });
        </script>

        <table>
            <tr>
                <th>File</th>
                <th>LOC</th>
                <th>Total (µs)</th>
                <th>Match (µs)</th>
                <th>Match/LOC (µs)</th>
            </tr>`;

    for (const s of statsHistory.slice(-200).reverse()) {
        html += `<tr>
            <td>${s.name}</td>
            <td>${s.loc}</td>
            <td>${s.total_us.toFixed(0)}</td>
            <td>${s.match_us.toFixed(0)}</td>
            <td>${s.us_per_loc.toFixed(2)}</td>
        </tr>`;
    }

    html += `</table></body></html>`;
    res.send(html);
});

const server = app.listen(PORT, () => {
    console.log('Listening for files on port', PORT);
});

// Page generation
// --------------------
function getStatistics() {
    let cloneStore = CloneStorage.getInstance();
    let fileStore = FileStorage.getInstance();
    return 'Processed ' + fileStore.numberOfFiles + ' files containing ' + cloneStore.numberOfClones + ' clones.';
}

function lastFileTimersHTML() {
    if (!lastFile) return '';
    let output = '<p>Timers for last file processed:</p>\n<ul>\n';
    let timers = Timer.getTimers(lastFile);
    for (let t in timers) {
        output += '<li>' + t + ': ' + (timers[t] / (1000n)) + ' µs\n';
    }
    output += '</ul>\n';
    return output;
}

function listClonesHTML() {
    let cloneStore = CloneStorage.getInstance();
    let output = '';

    // 🩹 FIX #2 — guard for undefined or empty clone arrays
    if (!cloneStore || !Array.isArray(cloneStore.clones) || cloneStore.clones.length === 0) {
        return "<p>No clone data found or unable to load clones.</p>";
    }

    cloneStore.clones.forEach(clone => {
        if (!clone || !clone.sourceName || !Array.isArray(clone.targets)) return; // skip invalid entries

        output += '<hr>\n';
        output += '<h2>Source File: ' + clone.sourceName + '</h2>\n';
        output += '<p>Starting at line: ' + clone.sourceStart + ' , ending at line: ' + clone.sourceEnd + '</p>\n';
        output += '<ul>';
        clone.targets.forEach(target => {
            if (!target || !target.name) return;
            output += '<li>Found in ' + target.name + ' starting at line ' + (target.startLine || '?') + '\n';
        });
        output += '</ul>\n';
        output += '<h3>Contents:</h3>\n<pre><code>\n';
        output += clone.originalCode || '';
        output += '</code></pre>\n';
    });

    return output;
}

function listProcessedFilesHTML() {
    let fs = FileStorage.getInstance();
    let output = '<HR>\n<H2>Processed Files</H2>\n';
    output += fs.filenames.reduce((out, name) => {
        out += '<li>' + name + '\n';
        return out;
    }, '<ul>\n');
    output += '</ul>\n';
    return output;
}

function viewClones(req, res, next) {
    let page = '<HTML><HEAD><TITLE>CodeStream Clone Detector</TITLE></HEAD>\n';
    page += '<BODY><H1>CodeStream Clone Detector</H1>\n';
    page += '<P>' + getStatistics() + '</P>\n';
    page += lastFileTimersHTML() + '\n';
    page += listClonesHTML() + '\n';
    page += listProcessedFilesHTML() + '\n';
    page += '</BODY></HTML>';
    res.send(page);
}

// Helpers
// --------------------
PASS = fn => d => {
    try {
        fn(d);
        return d;
    } catch (e) {
        throw e;
    }
};

const STATS_FREQ = 100;
const URL = process.env.URL || 'http://localhost:8080/';
let lastFile = null;

function maybePrintStatistics(file, cloneDetector, cloneStore) {
    if (0 == cloneDetector.numberOfProcessedFiles % STATS_FREQ) {
        console.log('Processed', cloneDetector.numberOfProcessedFiles, 'files and found', cloneStore.numberOfClones, 'clones.');
        let timers = Timer.getTimers(file);
        let str = 'Timers for last file processed: ';
        for (let t in timers) {
            str += t + ': ' + (timers[t] / (1000n)) + ' µs ';
        }
        console.log(str);
        console.log('List of found clones available at', URL);
    }
    return file;
}

// Processing pipeline
// --------------------
function processFile(filename, contents) {
    let cd = new CloneDetector();
    let cloneStore = CloneStorage.getInstance();

    return Promise.resolve({ name: filename, contents: contents })
        .then(file => Timer.startTimer(file, 'total'))
        .then(file => cd.preprocess(file))
        .then(file => cd.transform(file))
        .then(file => Timer.startTimer(file, 'match'))
        .then(file => cd.matchDetect(file))
        .then(file => cloneStore.storeClones(file))
        .then(file => Timer.endTimer(file, 'match'))
        .then(file => cd.storeFile(file))
        .then(file => Timer.endTimer(file, 'total'))
        .then(file => { recordStatsSample(file); return file; }) // 🆕 record timing stats
        .then(PASS(file => lastFile = file))
        .then(PASS(file => maybePrintStatistics(file, cd, cloneStore)))
        .catch(console.log);
}

/*
Pipeline:
1. Preprocessing: Remove uninteresting code.
2. Transformation: Transform to intermediate representation.
3. Match Detection: Compare transformed units for similarity.
4. Formatting: Map identified clones to original code lines.
5. Post-Processing: Filter false positives, visualize results.
6. Aggregation: Combine clones into families for analysis.
*/
