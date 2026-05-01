'use strict';

const CAT_ORDER_ALL = ['Vacancies', 'Real Estate', 'Vehicles', 'Notices'];
const CAT_SLUGS = {
  'Vacancies':   'classifieds_Vacancies.json',
  'Real Estate': 'classifieds_Real_Estate.json',
  'Vehicles':    'classifieds_Vehicles.json',
  'Notices':     'classifieds_Notices.json',
};

async function fetchMeta() {
  try {
    const r = await fetch('/data/meta.json');
    if (r.ok) return r.json();
  } catch {}
  return null;
}

/* opts.cats = array of category names to load; null = all available */
async function fetchClassifieds(opts) {
  const cats = opts && opts.cats ? opts.cats : null;

  /* Check localStorage first (saved by extraction page) */
  try {
    const stored = localStorage.getItem('gleaner_classifieds');
    if (stored) {
      const data = JSON.parse(stored);
      if (data && Array.isArray(data.records) && data.records.length > 0) {
        let records = data.records;
        let id = 0;
        records = records.map(r => ({ ...r, id: ++id }));
        if (cats) records = records.filter(r => cats.includes(r.cat));
        return { ...data, records };
      }
    }
  } catch {}

  /* Try per-category files first (new format) */
  const meta = await fetchMeta();
  if (meta && Array.isArray(meta.available) && meta.available.length > 0) {
    const toFetch = cats ? cats.filter(c => meta.available.includes(c)) : meta.available;
    const allRecords = [];
    let idOffset = 0;
    for (const cat of CAT_ORDER_ALL.filter(c => toFetch.includes(c))) {
      const slug = CAT_SLUGS[cat];
      try {
        const r = await fetch('/data/' + slug);
        if (r.ok) {
          const d = await r.json();
          (d.records || []).forEach(rec => {
            allRecords.push({ ...rec, id: ++idOffset });
          });
        }
      } catch {}
    }
    return { meta, records: allRecords };
  }

  /* Fall back to combined file */
  const res = await fetch('/data/classifieds.json');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (cats) {
    return { ...data, records: (data.records || []).filter(r => cats.includes(r.cat)) };
  }
  return data;
}

window.fetchMeta = fetchMeta;

// Accepts contact as string (old) or object { phones, emails } (new)
function contactPhones(c) {
  if (!c) return [];
  if (typeof c === 'object') return c.phones || [];
  const raw = c.match(/876[-\s]?\d{3}[-\s]?\d{4}/g) || [];
  return [...new Set(raw.map(p => { const d = p.replace(/\D/g,''); return d.slice(0,3)+'-'+d.slice(3,6)+'-'+d.slice(6,10); }))];
}
function contactStr(c) {
  if (!c) return '';
  if (typeof c === 'string') return c;
  return [...(c.phones||[]),...(c.emails||[])].join(' / ');
}
// Legacy alias used by FilterEngine search hay and other string consumers
function extractPhones(c) { return contactPhones(c); }

function buildContactGroups(data) {
  const map = {};
  data.forEach(r => {
    contactPhones(r.contact).forEach(p => {
      if (!map[p]) map[p] = [];
      map[p].push(r.id);
    });
  });
  return Object.fromEntries(
    Object.entries(map)
      .filter(([, ids]) => ids.length >= 2)
      .sort((a, b) => b[1].length - a[1].length)
  );
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

class FilterEngine {
  constructor(data) {
    this.allData = data;
    this.contactGroups = buildContactGroups(data);
    this.active = { cats: new Set(), types: new Set(), locs: new Set(), contacts: new Set(),
                    search: '', priceMin: null, priceMax: null, negOnly: false, sectionFilters: {} };
  }
  _phoneMatch(item) {
    const { contacts } = this.active;
    if (contacts.size === 0) return true;
    return extractPhones(item.contact).some(p => contacts.has(p));
  }
  match(item) {
    const { cats, types, locs, search, priceMin, priceMax, negOnly } = this.active;
    if (cats.size  > 0 && !cats.has(item.cat))    return false;
    if (types.size > 0 && !types.has(item.type))  return false;
    if (locs.size  > 0 && !locs.has(item.parish)) return false;
    if (!this._phoneMatch(item))                   return false;
    if (priceMin !== null && (item.price_jmd === null || item.price_jmd < priceMin)) return false;
    if (priceMax !== null && (item.price_jmd === null || item.price_jmd > priceMax)) return false;
    if (negOnly && !item.price_neg) return false;
    const sf = this.active.sectionFilters[item.cat];
    if (sf) {
      if (sf.types    && sf.types.size    > 0 && !sf.types.has(item.type))      return false;
      if (sf.parishes && sf.parishes.size > 0 && !sf.parishes.has(item.parish)) return false;
    }
    if (search) {
      const hay = [item.cat, item.type, item.title, item.loc, item.notes, contactStr(item.contact), item.price_text].join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }
  filter() { return this.allData.filter(d => this.match(d)); }
  get(field) {
    return [...new Set(this.allData.map(d => d[field]).filter(Boolean))].sort();
  }
  countBy(field, val) {
    return this.allData.filter(d => d[field] === val).length;
  }
  matchExcluding(item, excludeKey) {
    const { cats, types, locs, contacts, search, priceMin, priceMax, negOnly } = this.active;
    if (excludeKey !== 'cat'      && cats.size     > 0 && !cats.has(item.cat))    return false;
    if (excludeKey !== 'type'     && types.size    > 0 && !types.has(item.type))  return false;
    if (excludeKey !== 'loc'      && locs.size     > 0 && !locs.has(item.parish)) return false;
    if (excludeKey !== 'contacts' && contacts.size > 0 && !this._phoneMatch(item)) return false;
    if (priceMin !== null && (item.price_jmd === null || item.price_jmd < priceMin)) return false;
    if (priceMax !== null && (item.price_jmd === null || item.price_jmd > priceMax)) return false;
    if (negOnly && !item.price_neg) return false;
    if (search) {
      const hay = [item.cat, item.type, item.title, item.loc, item.notes, contactStr(item.contact), item.price_text].join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }
  availableFor(excludeKey, propName) {
    const counts = {};
    this.allData.forEach(d => {
      if (this.matchExcluding(d, excludeKey)) {
        const val = d[propName];
        if (val) counts[val] = (counts[val] || 0) + 1;
      }
    });
    return counts;
  }
  availableContacts() {
    const counts = {};
    this.allData.forEach(d => {
      if (this.matchExcluding(d, 'contacts')) {
        contactPhones(d.contact).forEach(p => {
          if (this.contactGroups[p]) counts[p] = (counts[p] || 0) + 1;
        });
      }
    });
    return counts;
  }
}

function buildCheckboxes(containerId, items, group, countFn, onChange) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  items.forEach(item => {
    const lbl = document.createElement('label');
    lbl.className = 'checkbox-item';
    lbl.innerHTML =
      '<input type="checkbox" data-group="' + group + '" data-value="' + esc(item) + '">' +
      '<span class="checkbox-label">' + esc(item) + '</span>' +
      '<span class="checkbox-badge">' + countFn(item) + '</span>';
    lbl.querySelector('input').addEventListener('change', onChange);
    el.appendChild(lbl);
  });
}

function buildContactCheckboxes(containerId, contactGroups, onChange) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  Object.entries(contactGroups).forEach(([phone, ids]) => {
    const lbl = document.createElement('label');
    lbl.className = 'checkbox-item';
    lbl.innerHTML =
      '<input type="checkbox" data-group="contacts" data-value="' + esc(phone) + '">' +
      '<span class="checkbox-label cb-phone">' + esc(phone) + '</span>' +
      '<span class="checkbox-badge">' + ids.length + '</span>';
    lbl.querySelector('input').addEventListener('change', onChange);
    el.appendChild(lbl);
  });
}

function refreshCheckboxGroup(containerId, available, activeSet) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.checkbox-item').forEach(item => {
    const cb    = item.querySelector('input[type="checkbox"]');
    const badge = item.querySelector('.checkbox-badge');
    const val   = cb.dataset.value;
    const count = available[val] || 0;
    const selected = activeSet.has(val);
    if (count > 0) {
      item.style.display = ''; item.style.opacity = '';
      badge.textContent = count; badge.style.background = ''; badge.style.color = '';
    } else if (selected) {
      item.style.display = ''; item.style.opacity = '0.55';
      badge.textContent = '0'; badge.style.background = '#fee2e2'; badge.style.color = '#991b1b';
    } else {
      item.style.display = 'none';
    }
  });
}

const _PHONE_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px;flex-shrink:0"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.9 13 19.79 19.79 0 0 1 1.86 4.48 2 2 0 0 1 3.82 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';

const _EXPAND_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="10,2 14,2 14,6"/><polyline points="6,14 2,14 2,10"/><line x1="14" y1="2" x2="9" y2="7"/><line x1="2" y1="14" x2="7" y2="9"/></svg>';

/* ── Price formatting ── */
let _priceFmt = 'comma';

function formatPrice(val, fmt) {
  fmt = fmt || _priceFmt;
  if (val === null || val === undefined || val === '') return '—';
  const n = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(n)) return '—';
  if (fmt === 'k') {
    if (n >= 1000000) {
      const m = n / 1000000;
      return (m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)) + 'M';
    }
    if (n >= 1000) {
      const k = n / 1000;
      return (k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)) + 'k';
    }
    return n.toLocaleString();
  }
  return n.toLocaleString();
}

function updatePriceDisplay(fmt) {
  _priceFmt = fmt;
  document.querySelectorAll('.col-price[data-price], .card-price[data-price]').forEach(el => {
    const raw = el.dataset.price;
    const neg = el.dataset.priceNeg === '1';
    const str = raw !== '' ? formatPrice(parseFloat(raw), fmt) : '—';
    el.innerHTML = esc(str) + (neg ? ' <span class="neg-badge">neg</span>' : '');
  });
}

function setPriceFormat(fmt) { updatePriceDisplay(fmt); }

/* ── Offline price parser ── */
function parsePrice(text) {
  if (!text || typeof text !== 'string') return { amount: null, neg: false };
  const t = text.trim();
  if (t === '—' || t === '-' || t === '') return { amount: null, neg: false };

  const neg = /(?<!\S)neg\b|\bnegot\w*\b|\bo\.?n\.?o\.?\b/i.test(t);

  /* Strip currency markers */
  const s = t.replace(/J\$/gi, '').replace(/USD\s*/gi, '').replace(/\$/g, '').replace(/JMD\s*/gi, '');

  /* Find all number+suffix candidates.
     Pattern handles: 1,500,000 | 1.5M | 30k | 3.5m | 5.6Mil | 7 mil | 850,000 */
  const RE = /(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(mill?(?:ion)?|[MmKk])\b|(\d{1,3}(?:,\d{3}){2,}|\d{7,})/gi;
  const candidates = [];
  let m;
  while ((m = RE.exec(s)) !== null) {
    if (m[1] !== undefined) {
      /* number + suffix group */
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (isNaN(val) || val === 0) continue;
      const suf = m[2].toLowerCase();
      let amount = val;
      if (/^m/.test(suf))      amount = val * 1_000_000;
      else if (/^k/.test(suf)) amount = val * 1_000;
      candidates.push(amount);
    } else if (m[3]) {
      /* bare large number (7+ digits or 3+ comma groups) */
      const digits = m[3].replace(/,/g, '');
      /* skip Jamaica phone numbers (10 digits starting with 876 or 1876) */
      if ((digits.length === 10 && digits.startsWith('876')) ||
          (digits.length === 11 && digits.startsWith('1876'))) continue;
      const val = parseFloat(digits);
      if (!isNaN(val) && val > 0) candidates.push(val);
    }
  }

  const amount = candidates.length > 0 ? Math.round(Math.min(...candidates)) : null;
  return { amount, neg };
}

/* Re-derives price_jmd and sets price_neg on each record using the offline parser.
   Only overrides price_jmd when: (a) it's missing, or (b) the text contains M/K multipliers
   (the AI frequently mis-converts these). */
/* Matches any number immediately followed by a magnitude suffix (case-insensitive, multi-form) */
const _MULTIPLIER_RE = /\d\s*(?:mill?(?:ion)?|[MmKk])\b/i;
/* Matches any word starting with "neg" (neg, nego, negd, negotiable…) or O.N.O / ONO variants */
const _NEG_RE = /(?<!\S)neg\b|\bnegot\w*\b|\bo\.?n\.?o\.?\b/i;

function repairPrices(records) {
  for (const r of records) {
    const p = parsePrice(r.price_text);
    if (p.amount !== null) {
      const hasMultiplier = _MULTIPLIER_RE.test(r.price_text || '');
      if (r.price_jmd == null || hasMultiplier) r.price_jmd = p.amount;
    }
    /* Fall back: scan notes for a price when price_text gave nothing */
    if (r.price_jmd == null && r.notes) {
      const np = parsePrice(r.notes);
      if (np.amount !== null) r.price_jmd = np.amount;
    }
    r.price_neg = p.neg || _NEG_RE.test(r.notes || '') || _NEG_RE.test(r.price_text || '');

    if (Array.isArray(r.items)) {
      for (const it of r.items) {
        const ip = parsePrice(it.price_text);
        if (ip.amount !== null) {
          const hasM = _MULTIPLIER_RE.test(it.price_text || '');
          if (it.price_jmd == null || hasM) it.price_jmd = ip.amount;
        }
        if (it.price_jmd == null && it.desc) {
          const dp = parsePrice(it.desc);
          if (dp.amount !== null) it.price_jmd = dp.amount;
        }
        it.price_neg = ip.neg || _NEG_RE.test(it.desc || '');
      }
      /* Re-derive top-level min from items */
      const itemAmounts = r.items.map(it => it.price_jmd).filter(v => v != null);
      if (itemAmounts.length > 0 && r.price_jmd == null) r.price_jmd = Math.min(...itemAmounts);
    }
  }
  return records;
}

/* ── Contact formatting ── */
// Accepts contact as string (legacy) or { phones, emails } object.
// Phones stored in the object are already normalised by app.js cleanContact.
// assumed = phone was inferred from 7-digit (stored as { phones, emails, assumed: [true/false,...] })
// For legacy strings we re-parse to detect assumption.
function _contactToDisplayParts(c) {
  if (!c) return [];

  // New object format
  if (typeof c === 'object') {
    const phoneParts = (c.phones || []).map((v, i) => ({
      val: v, assumed: Array.isArray(c.assumed) ? !!c.assumed[i] : false, isEmail: false
    }));
    const emailParts = (c.emails || []).map(v => ({ val: v, assumed: false, isEmail: true }));
    return [...phoneParts, ...emailParts];
  }

  // Legacy string — re-parse to detect assumption
  if (c === '—') return [];
  const emails = (c.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [])
                   .map(v => ({ val: v, assumed: false, isEmail: true }));
  const scrubbed = c.replace(/[.()\-\s]+/g, ' ');
  const parts = []; const seen = new Set(); let m;
  const fullRe = /(?:\+?1\s)?876\s(\d{3})\s(\d{4})/g;
  while ((m = fullRe.exec(scrubbed)) !== null) {
    const n = '876-' + m[1] + '-' + m[2];
    if (!seen.has(n)) { seen.add(n); parts.push({ val: n, assumed: false, isEmail: false }); }
  }
  const spacedRe = /\b(\d{3})\s(\d{4})\b/g;
  while ((m = spacedRe.exec(scrubbed)) !== null) {
    const n = '876-' + m[1] + '-' + m[2];
    if (!seen.has(n)) { seen.add(n); parts.push({ val: n, assumed: true, isEmail: false }); }
  }
  const bare7Re = /\b(\d{3})(\d{4})\b/g;
  while ((m = bare7Re.exec(scrubbed)) !== null) {
    const n = '876-' + m[1] + '-' + m[2];
    if (!seen.has(n)) { seen.add(n); parts.push({ val: n, assumed: true, isEmail: false }); }
  }
  return [...parts, ...emails];
}

/* ── Contact formatting (multi-number → line-per-number, with assumed-areacode highlight) ── */
function formatContact(c) {
  const parts = _contactToDisplayParts(c);
  if (!parts.length) return '—';
  return parts.map(p => {
    if (!p.isEmail && p.assumed && p.val.startsWith('876-')) {
      return '<span class="contact-areacode-assumed" title="Area code 876 assumed — Jamaica also uses 658, please verify">876</span>' + esc(p.val.slice(3));
    }
    return esc(p.val);
  }).join('<br>');
}

function formatPhones(c) {
  const parts = _contactToDisplayParts(c).filter(p => !p.isEmail);
  if (!parts.length) return '<span class="col-empty">\u2014</span>';
  return parts.map(p => {
    if (p.assumed && p.val.startsWith('876-'))
      return '<div class="contact-entry"><span class="contact-areacode-assumed" title="Area code 876 assumed \u2014 Jamaica also uses 658, please verify">876</span>' + esc(p.val.slice(3)) + '</div>';
    return '<div class="contact-entry">' + esc(p.val) + '</div>';
  }).join('');
}

function formatEmails(c) {
  const parts = _contactToDisplayParts(c).filter(p => p.isEmail);
  if (!parts.length) return '<span class="col-empty">\u2014</span>';
  return parts.map(p =>
    '<div class="contact-entry"><a class="contact-email-link" href="mailto:' + esc(p.val) + '">' + esc(p.val) + '</a></div>'
  ).join('');
}

function renderPills(containerId, filters, onRemove) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  const pill = (innerHTML, onX) => {
    const p = document.createElement('span');
    p.className = 'filter-pill';
    p.innerHTML = innerHTML + ' <span class="x">\u00d7</span>';
    p.addEventListener('click', onX);
    return p;
  };
  const { cats, types, locs, contacts, search, negOnly } = filters;
  cats.forEach(v     => el.appendChild(pill(esc(v),                           () => onRemove('cat',      v))));
  types.forEach(v    => el.appendChild(pill(esc(v),                           () => onRemove('type',     v))));
  locs.forEach(v     => el.appendChild(pill(esc(v),                           () => onRemove('loc',      v))));
  contacts.forEach(v => el.appendChild(pill(_PHONE_SVG + esc(v),              () => onRemove('contacts', v))));
  if (search)  el.appendChild(pill('\u201c' + esc(search) + '\u201d',         () => onRemove('search',  null)));
  if (negOnly) el.appendChild(pill('<span class="neg-badge">neg</span> only', () => onRemove('negOnly', null)));
}

// Sortable column definitions: header label → item field + comparator
const _SORT_COLS = {
  'Title / Role': { field: 'title',     cmp: (a, b) => (a||'').localeCompare(b||'') },
  'Type':         { field: 'type',      cmp: (a, b) => (a||'').localeCompare(b||'') },
  'Parish':       { field: 'parish',    cmp: (a, b) => (a||'').localeCompare(b||'') },
  'Price':        { field: 'price_jmd', cmp: (a, b) => (a ?? -1) - (b ?? -1) },
};

function buildGroupedTable(containerId, data, groupField, rowRenderer, colHeaders, engine) {
  const grouped = {};
  data.forEach((item, idx) => {
    (grouped[item[groupField]] || (grouped[item[groupField]] = [])).push({ ...item, _idx: idx });
  });
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  const CAT_ORDER = ['Vacancies', 'Real Estate', 'Vehicles', 'Notices'];
  const sortedKeys = Object.keys(grouped).sort((a, b) => {
    const ai = CAT_ORDER.indexOf(a), bi = CAT_ORDER.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return  1;
    return a.localeCompare(b);
  });
  sortedKeys.forEach(grp => {
    const items = grouped[grp];
    const sec = document.createElement('div');
    sec.className = 'category-section';
    sec.dataset[groupField] = grp;

    // Sort state for this section: { col: label, dir: 1 | -1 }
    const sortState = { col: null, dir: 1 };

    const ths = colHeaders.map(h => {
      const sortable = !!_SORT_COLS[h];
      return '<th' + (sortable ? ' class="col-sortable" data-sort="' + esc(h) + '"' : '') + '>' +
             h + (sortable ? '<span class="sort-arrow"></span>' : '') +
             '</th>';
    }).join('') + '<th class="col-expand"></th>';

    const colCount = colHeaders.length + 1;
    const renderBody = () => {
      const sorted = [...items];
      if (sortState.col && _SORT_COLS[sortState.col]) {
        const { field, cmp } = _SORT_COLS[sortState.col];
        sorted.sort((a, b) => sortState.dir * cmp(a[field], b[field]));
      }
      return sorted.map(item =>
        '<tr data-id="' + item.id + '">' + rowRenderer(item) +
          '<td class="col-expand"><button class="expand-btn" title="View detail">' + _EXPAND_SVG + '</button></td>' +
        '</tr>'
      ).join('');
    };

    sec.innerHTML =
      '<div class="cat-header">' +
        '<span class="cat-name">' + esc(grp) + '</span>' +
        '<span class="cat-count-badge">' + items.length + '</span>' +
        '<span class="cat-visible-count"></span>' +
      '</div>' +
      '<table><thead><tr>' + ths + '</tr></thead>' +
      '<tbody>' + renderBody() + '</tbody></table>';

    // Attach sort click handlers
    sec.querySelectorAll('th.col-sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortState.col === col) {
          sortState.dir *= -1;
        } else {
          sortState.col = col;
          sortState.dir = 1;
        }
        // Update arrow indicators for this section only
        sec.querySelectorAll('th.col-sortable').forEach(t => {
          const arrow = t.querySelector('.sort-arrow');
          if (!arrow) return;
          if (t.dataset.sort === sortState.col) {
            arrow.textContent = sortState.dir === 1 ? ' ▲' : ' ▼';
            t.classList.add('sort-active');
          } else {
            arrow.textContent = '';
            t.classList.remove('sort-active');
          }
        });
        sec.querySelector('tbody').innerHTML = renderBody();
        // Re-apply filter visibility to the freshly rendered rows
        if (engine) {
          sec.querySelectorAll('tbody tr[data-id]').forEach(row => {
            const id   = parseInt(row.dataset.id);
            const item = engine.allData.find(d => d.id === id);
            const show = item ? engine.match(item) : false;
            row.classList.toggle('hidden', !show);
          });
          const vis = sec.querySelectorAll('tbody tr[data-id]:not(.hidden)').length;
          const tot = items.length;
          const vc = sec.querySelector('.cat-visible-count');
          if (vc) vc.textContent = vis === tot ? '' : vis + ' of ' + tot + ' shown';
        }
      });
    });

    container.appendChild(sec);
  });
}

const _CAT_COLORS = {
  'Vacancies':   '#e63946',
  'Real Estate': '#1a4fa0',
  'Vehicles':    '#f4a620',
  'Notices':     '#6b7280',
};

function buildGallery(containerId, data) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const CAT_ORDER = ['Vacancies', 'Real Estate', 'Vehicles', 'Notices'];
  const grouped   = {};
  data.forEach(item => { (grouped[item.cat] || (grouped[item.cat] = [])).push(item); });

  CAT_ORDER.filter(cat => grouped[cat]).forEach(cat => {
    const items = grouped[cat];
    const color = _CAT_COLORS[cat] || '#475569';

    const sec = document.createElement('div');
    sec.className   = 'gallery-cat-section';
    sec.dataset.cat = cat;

    const hdr = document.createElement('div');
    hdr.className = 'gallery-cat-header';
    hdr.innerHTML =
      '<span class="cat-name">' + esc(cat) + '</span>' +
      '<span class="cat-count-badge">' + items.length + '</span>' +
      '<span class="cat-visible-count"></span>';
    sec.appendChild(hdr);

    const grid = document.createElement('div');
    grid.className = 'gallery-grid';
    items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'listing-card';
      card.dataset.id = item.id;
      card.style.borderLeftColor = color;
      const notesShort = item.notes && item.notes.length > 110 ? item.notes.slice(0, 110) + '\u2026' : (item.notes || '');
      const priceAttr = item.price_jmd != null ? item.price_jmd : '';
      card.innerHTML =
        '<div class="card-header">' +
          '<span class="card-title">' + esc(item.title) + '</span>' +
          '<div class="card-header-right">' +
            '<span class="badge badge-' + esc(item.type).replace(/\s+/g,'-') + '">' + esc(item.type) + '</span>' +
            '<button class="expand-btn card-expand" title="View detail">' + _EXPAND_SVG + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-meta">' +
          '<span class="card-parish">' + esc(item.parish) + '</span>' +
          '<span class="card-price" data-price="' + priceAttr + '" data-price-neg="' + (item.price_neg ? '1' : '0') + '">' + esc(formatPrice(item.price_jmd)) + (item.price_neg ? ' <span class="neg-badge">neg</span>' : '') + '</span>' +
        '</div>' +
        '<div class="card-notes">'   + esc(notesShort) + '</div>' +
        '<div class="card-contact">' + formatContact(item.contact) + '</div>';
      grid.appendChild(card);
    });
    sec.appendChild(grid);
    container.appendChild(sec);
  });
}

function applyVisibility(engine, containerId, countId) {
  let total = 0;
  document.querySelectorAll('#' + containerId + ' .category-section').forEach(sec => {
    const rows = sec.querySelectorAll('tbody tr[data-id]');
    let vis = 0;
    rows.forEach(row => {
      const id   = parseInt(row.dataset.id);
      const item = engine.allData.find(d => d.id === id);
      const show = item ? engine.match(item) : false;
      row.classList.toggle('hidden', !show);
      if (show) vis++;
    });
    sec.classList.toggle('hidden', vis === 0);
    const vc  = sec.querySelector('.cat-visible-count');
    const tot = parseInt(sec.querySelector('.cat-count-badge').textContent);
    if (vc) vc.textContent = vis === tot ? '' : vis + ' of ' + tot + ' shown';
    total += vis;
  });
  const countEl = document.getElementById(countId);
  if (countEl) countEl.textContent = total;
  const nr = document.getElementById('no-results');
  if (nr) nr.classList.toggle('visible', total === 0);
  return total;
}

function applyGalleryFilter(engine, containerId, countId) {
  let total = 0;
  document.querySelectorAll('#' + containerId + ' .gallery-cat-section').forEach(sec => {
    const cards = sec.querySelectorAll('.listing-card');
    let vis = 0;
    cards.forEach(card => {
      const id   = parseInt(card.dataset.id);
      const item = engine.allData.find(d => d.id === id);
      const show = item ? engine.match(item) : false;
      card.classList.toggle('hidden', !show);
      if (show) vis++;
    });
    sec.classList.toggle('hidden', vis === 0);
    const vc  = sec.querySelector('.cat-visible-count');
    const tot = parseInt(sec.querySelector('.cat-count-badge').textContent);
    if (vc) vc.textContent = vis === tot ? '' : vis + ' of ' + tot + ' shown';
    total += vis;
  });
  const countEl = document.getElementById(countId);
  if (countEl) countEl.textContent = total;
  const nr = document.getElementById('no-results');
  if (nr) nr.classList.toggle('visible', total === 0);
  return total;
}

let _sfDocListenerAdded = false;

function attachSectionFilters(containerId, engine, applyFn) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!_sfDocListenerAdded) {
    document.addEventListener('click', () => {
      document.querySelectorAll('.sf-panel.sf-open').forEach(p => p.classList.remove('sf-open'));
    });
    _sfDocListenerAdded = true;
  }

  container.querySelectorAll('.category-section, .gallery-cat-section').forEach(sec => {
    const cat = sec.dataset.cat;
    if (!cat) return;
    if (sec.querySelector('.sf-wrap')) return; // already attached

    const catItems = engine.allData.filter(d => d.cat === cat);
    const types    = [...new Set(catItems.map(d => d.type).filter(Boolean))].sort();
    const parishes = [...new Set(catItems.map(d => d.parish).filter(Boolean))].sort();
    if (types.length <= 1 && parishes.length <= 1) return;

    const hdr = sec.querySelector('.cat-header, .gallery-cat-header');
    if (!hdr) return;

    if (!engine.active.sectionFilters[cat]) {
      engine.active.sectionFilters[cat] = { types: new Set(), parishes: new Set() };
    }
    const sf = engine.active.sectionFilters[cat];

    const wrap  = document.createElement('div');
    wrap.className = 'sf-wrap';
    const btn   = document.createElement('button');
    btn.className = 'sf-btn';
    btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="4" x2="14" y2="4"/><line x1="4" y1="8" x2="12" y2="8"/><line x1="6" y1="12" x2="10" y2="12"/></svg> Filter';
    const panel = document.createElement('div');
    panel.className = 'sf-panel';
    panel.addEventListener('click', e => e.stopPropagation());

    function buildPanelContent() {
      let html = '';
      function grpHtml(label, items, sfSet, key) {
        if (items.length <= 1) return '';
        return '<div class="sf-group"><div class="sf-group-label">' + label + '</div>' +
          items.map(v => '<label class="sf-check"><input type="checkbox"' +
            ' data-sf-key="' + key + '" data-sf-val="' + esc(v) + '"' +
            (sfSet.has(v) ? ' checked' : '') + '><span>' + esc(v) + '</span></label>').join('') +
          '</div>';
      }
      html += grpHtml('Type', types, sf.types, 'types');
      html += grpHtml('Parish', parishes, sf.parishes, 'parishes');
      html += '<div class="sf-footer"><button class="sf-clear">Clear section</button></div>';
      panel.innerHTML = html;
      panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          cb.checked ? sf[cb.dataset.sfKey].add(cb.dataset.sfVal) : sf[cb.dataset.sfKey].delete(cb.dataset.sfVal);
          syncBtnState();
          applyFn();
        });
      });
      panel.querySelector('.sf-clear').addEventListener('click', () => {
        sf.types.clear(); sf.parishes.clear();
        panel.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = false);
        syncBtnState();
        applyFn();
      });
    }

    function syncBtnState() {
      const n = sf.types.size + sf.parishes.size;
      btn.classList.toggle('sf-btn-active', n > 0);
      let badge = btn.querySelector('.sf-count');
      if (n > 0) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'sf-count'; btn.appendChild(badge); }
        badge.textContent = n;
      } else if (badge) { badge.remove(); }
    }

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = panel.classList.contains('sf-open');
      document.querySelectorAll('.sf-panel.sf-open').forEach(p => p.classList.remove('sf-open'));
      if (!wasOpen) { buildPanelContent(); panel.classList.add('sf-open'); }
    });

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    hdr.appendChild(wrap);
  });
}

/* ── Listing Detail Modal ── */
const _modal = {
  el: null, items: [], idx: 0,

  init() {
    if (this.el) return;
    const div = document.createElement('div');
    div.id = 'listing-modal';
    div.className = 'modal-overlay';
    div.setAttribute('role', 'dialog');
    div.setAttribute('aria-modal', 'true');
    div.style.display = 'none';
    div.innerHTML =
      '<div class="modal-box">' +
        '<div class="modal-topbar">' +
          '<span class="modal-cat-badge"></span>' +
          '<span class="modal-pos"></span>' +
          '<button class="modal-close" aria-label="Close">&#x2715;</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div class="modal-title-row">' +
            '<h2 class="modal-title"></h2>' +
            '<span class="modal-type-badge"></span>' +
          '</div>' +
          '<div class="modal-chips-row">' +
            '<div class="modal-chip">' +
              '<div class="modal-chip-label">Parish</div>' +
              '<div class="modal-chip-val modal-parish-val"></div>' +
            '</div>' +
            '<div class="modal-chip modal-chip-price">' +
              '<div class="modal-chip-label">Price</div>' +
              '<div class="modal-chip-val modal-price-val"></div>' +
            '</div>' +
          '</div>' +
          '<div class="modal-section-label">Details</div>' +
          '<div class="modal-notes-val"></div>' +
          '<div class="modal-items-section" style="display:none">' +
            '<div class="modal-section-label">Units &amp; Options</div>' +
            '<div class="modal-items-tree"></div>' +
          '</div>' +
          '<div class="modal-section-label">Contact</div>' +
          '<div class="modal-contact-grid">' +
            '<div class="modal-contact-col modal-col-phones">' +
              '<div class="modal-contact-col-label">Phone</div>' +
              '<div class="modal-phones-val"></div>' +
            '</div>' +
            '<div class="modal-contact-col modal-col-emails">' +
              '<div class="modal-contact-col-label">Email</div>' +
              '<div class="modal-emails-val"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-nav-row">' +
          '<button class="modal-prev">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="10,3 6,8 10,13"/></svg>' +
            ' Prev' +
          '</button>' +
          '<button class="modal-next">' +
            'Next ' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6,3 10,8 6,13"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(div);
    this.el = div;
    div.addEventListener('click', e => { if (e.target === div) this.close(); });
    div.querySelector('.modal-close').addEventListener('click', () => this.close());
    div.querySelector('.modal-prev').addEventListener('click', () => this._step(-1));
    div.querySelector('.modal-next').addEventListener('click', () => this._step(1));
    document.addEventListener('keydown', e => {
      if (!this.el || this.el.style.display === 'none') return;
      if (e.key === 'Escape')      this.close();
      if (e.key === 'ArrowLeft')   this._step(-1);
      if (e.key === 'ArrowRight')  this._step(1);
    });
  },

  open(id, items) {
    this.init();
    this.items = items;
    this.idx   = Math.max(0, items.findIndex(x => x.id === id));
    this._render();
    this.el.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  },

  close() {
    if (this.el) this.el.style.display = 'none';
    document.body.style.overflow = '';
  },

  _step(dir) {
    const n = this.idx + dir;
    if (n >= 0 && n < this.items.length) { this.idx = n; this._render(); }
  },

  _render() {
    const item = this.items[this.idx];
    if (!item || !this.el) return;
    const q = s => this.el.querySelector(s);
    q('.modal-cat-badge').textContent  = item.cat;
    q('.modal-cat-badge').className    = 'modal-cat-badge modal-cat-' + (item.cat || '').replace(/\s+/g, '-');
    q('.modal-pos').textContent        = (this.idx + 1) + ' of ' + this.items.length;
    q('.modal-title').textContent      = item.title;
    q('.modal-type-badge').textContent = item.type;
    q('.modal-type-badge').className   = 'modal-type-badge badge badge-' + esc(item.type).replace(/\s+/g,'-');
    q('.modal-parish-val').textContent = item.parish || '—';
    const priceStr = item.price_jmd != null ? formatPrice(item.price_jmd) : (item.price_text || '—');
    q('.modal-price-val').innerHTML = esc(priceStr) + (item.price_neg ? ' <span class="neg-badge">neg</span>' : '');
    q('.modal-notes-val').textContent  = item.notes  || '—';
    // Items tree
    const itemsEl = q('.modal-items-section');
    if (Array.isArray(item.items) && item.items.length > 0) {
      itemsEl.style.display = '';
      q('.modal-items-tree').innerHTML = item.items.map((it, i) => {
        const isLast = i === item.items.length - 1;
        const priceStr = it.price_jmd != null ? formatPrice(it.price_jmd) : (it.price_text || '\u2014');
        return '<div class="mit-row">' +
          '<span class="mit-desc">' + esc(it.desc) + '</span>' +
          '<span class="mit-price">' + esc(priceStr) + '</span>' +
          '</div>';
      }).join('');
    } else {
      itemsEl.style.display = 'none';
    }
    // Contact: split phones and emails into separate columns
    const _cParts = _contactToDisplayParts(item.contact);
    const _phones = _cParts.filter(p => !p.isEmail);
    const _emails = _cParts.filter(p => p.isEmail);
    q('.modal-phones-val').innerHTML = _phones.length ? _phones.map(p => {
      if (p.assumed && p.val.startsWith('876-'))
        return '<div class="modal-phone-entry"><span class="contact-areacode-assumed" title="Area code 876 assumed \u2014 Jamaica also uses 658, please verify">876</span>' + esc(p.val.slice(3)) + '</div>';
      return '<div class="modal-phone-entry">' + esc(p.val) + '</div>';
    }).join('') : '<div class="modal-no-contact">\u2014</div>';
    const emailCol = q('.modal-col-emails');
    if (_emails.length) {
      emailCol.style.display = '';
      q('.modal-emails-val').innerHTML = _emails.map(e =>
        '<div class="modal-email-entry"><a href="mailto:' + esc(e.val) + '">' + esc(e.val) + '</a></div>'
      ).join('');
    } else {
      emailCol.style.display = 'none';
    }
    q('.modal-prev').disabled = this.idx === 0;
    q('.modal-next').disabled = this.idx === this.items.length - 1;
  },
};

function openModal(id, items) { _modal.open(id, items); }

function countByField(data, field) {
  return data.reduce((acc, d) => { acc[d[field]] = (acc[d[field]] || 0) + 1; return acc; }, {});
}

function groupByField(data, field) {
  return data.reduce((acc, d) => { (acc[d[field]] || (acc[d[field]] = [])).push(d); return acc; }, {});
}

const PALETTE = {
  blue:  ['#1a4fa0','#2d6dd4','#4a8de8','#6aaaf5','#93c5fd','#bfdbfe','#dbeafe'],
  mixed: ['#1a4fa0','#166534','#854d0e','#6b21a8','#9f1239','#9a3412','#475569','#15803d','#0f766e','#92400e'],
  warm:  ['#e63946','#f4a620','#2d6dd4','#166534','#6b21a8','#9a3412','#475569'],
};

window.fetchClassifieds       = fetchClassifieds;
window.FilterEngine           = FilterEngine;
window.extractPhones          = extractPhones;
window.buildContactGroups     = buildContactGroups;
window.buildCheckboxes        = buildCheckboxes;
window.buildContactCheckboxes = buildContactCheckboxes;
window.refreshCheckboxGroup   = refreshCheckboxGroup;
window.renderPills            = renderPills;
window.buildGroupedTable      = buildGroupedTable;
window.buildGallery           = buildGallery;
window.applyVisibility        = applyVisibility;
window.applyGalleryFilter     = applyGalleryFilter;
window.countByField           = countByField;
window.groupByField           = groupByField;
window.PALETTE                = PALETTE;
window.esc                    = esc;
window.attachSectionFilters   = attachSectionFilters;
window.contactStr             = contactStr;
window.contactPhones          = contactPhones;
window.formatContact          = formatContact;
window.formatPhones           = formatPhones;
window.formatEmails           = formatEmails;
window.formatPrice            = formatPrice;
window.setPriceFormat         = setPriceFormat;
window.parsePrice             = parsePrice;
window.repairPrices           = repairPrices;
window.openModal              = openModal;
