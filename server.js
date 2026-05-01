const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app      = express();
const PORT     = 3003;
const DATA_DIR  = path.join(__dirname, 'public', 'data');
const DATA_FILE = path.join(DATA_DIR, 'classifieds.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

const CAT_SLUGS = {
  'Vacancies':   'classifieds_Vacancies.json',
  'Real Estate': 'classifieds_Real_Estate.json',
  'Vehicles':    'classifieds_Vehicles.json',
  'Notices':     'classifieds_Notices.json',
};

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, version: '3.0.0' }));

/* GET meta — available categories + edition info */
app.get('/data/meta.json', (req, res) => {
  if (!fs.existsSync(META_FILE)) return res.status(404).json({ error: 'no data' });
  res.sendFile(META_FILE);
});

/* GET combined classifieds (backward compat) */
app.get('/data/classifieds.json', (req, res) => {
  if (!fs.existsSync(DATA_FILE)) {
    return res.json({ meta: { total_records: 0, sections: [] }, records: [] });
  }
  res.sendFile(DATA_FILE);
});

/* GET per-category file */
app.get('/data/classifieds_:slug.json', (req, res) => {
  const file = path.join(DATA_DIR, `classifieds_${req.params.slug}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ records: [] });
  res.sendFile(file);
});

/* POST — save extraction: writes combined + per-category + meta */
app.post('/data/classifieds.json', (req, res) => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const { meta, records } = req.body;

    /* combined file (backward compat) */
    fs.writeFileSync(DATA_FILE, JSON.stringify(req.body, null, 2), 'utf8');

    /* per-category files */
    const available = [];
    Object.entries(CAT_SLUGS).forEach(([cat, filename]) => {
      const catRecords = (records || []).filter(r => r.cat === cat);
      if (catRecords.length > 0) {
        fs.writeFileSync(
          path.join(DATA_DIR, filename),
          JSON.stringify({ meta, records: catRecords }, null, 2),
          'utf8'
        );
        available.push(cat);
      }
    });

    /* meta file */
    fs.writeFileSync(META_FILE, JSON.stringify({
      ...(meta || {}),
      available,
      saved_at: new Date().toISOString(),
    }, null, 2), 'utf8');

    res.json({ ok: true, records: (records || []).length, categories: available });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log('');
  console.log('  Gleaner v3 — http://localhost:' + PORT);
  console.log('  Extract → http://localhost:' + PORT + '/');
  console.log('  Browse  → http://localhost:' + PORT + '/browse.html');
  console.log('  Charts  → http://localhost:' + PORT + '/charts.html');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
