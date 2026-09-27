const $ = (id) => document.getElementById(id);
const LEVEL_TH = { good: 'คุณภาพดี', fair: 'พอใช้', poor: 'กระตุก / แย่' };
const COLORS = { good: 'var(--good)', fair: 'var(--fair)', poor: 'var(--poor)' };
const ACTION_LABEL = { jump: '⚡ เด้งไป LIVE', lower: '📉 ลดความละเอียด' };
let tabId = null;

// ---------- settings ----------
const BOOL_KEYS = ['enabled', 'autoJumpOnStall', 'autoJumpOnLatency', 'autoLowerQuality', 'showOverlay'];
const NUM_KEYS = ['stallSeconds', 'frequentStalls', 'maxLatency', 'cooldown'];

chrome.storage.sync.get(YTLG_DEFAULTS, (s) => {
  BOOL_KEYS.forEach((k) => { $(k).checked = s[k]; });
  NUM_KEYS.forEach((k) => { $(k).value = s[k]; });
});
BOOL_KEYS.forEach((k) => $(k).addEventListener('change', (e) => chrome.storage.sync.set({ [k]: e.target.checked })));
NUM_KEYS.forEach((k) => $(k).addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (!isNaN(v) && v > 0) chrome.storage.sync.set({ [k]: v });
}));

// ---------- messaging ----------
function send(type) {
  if (tabId == null) return Promise.resolve(null);
  return chrome.tabs.sendMessage(tabId, { type }).catch(() => null);
}

$('jump').onclick = () => send('jump');
$('lower').onclick = () => send('lower');
$('auto').onclick = () => send('autoQuality');

function showMsg(text) {
  $('msg').textContent = text;
  $('msg').hidden = false;
  $('panel').hidden = true;
}

function fmtTime(t) {
  return new Date(t).toLocaleTimeString('th-TH', { hour12: false });
}

function render(s) {
  if (!s) return showMsg('เปิดไลฟ์ YouTube ในแท็บนี้ (ถ้าเพิ่งติดตั้ง ให้รีเฟรชหน้า YouTube 1 ครั้ง)');
  if (!s.enabled) return showMsg('ส่วนขยายถูกปิดอยู่');
  if (!s.live) return showMsg('วิดีโอนี้ไม่ใช่ไลฟ์สด');

  $('msg').hidden = true;
  $('panel').hidden = false;

  $('score').textContent = s.score;
  $('score').style.borderColor = COLORS[s.level];
  $('level').textContent = s.ad ? 'กำลังเล่นโฆษณา' : (s.stalling ? 'กำลังค้าง…' : LEVEL_TH[s.level]);
  $('level').style.color = COLORS[s.level];
  $('title').textContent = s.title;

  $('quality').textContent = s.quality;
  $('quality').title = s.resolution;
  $('buffer').textContent = `${s.buffer.toFixed(1)} วิ`;
  $('latency').textContent = s.latency == null ? '–' : `${s.latency.toFixed(1)} วิ`;
  $('drop').textContent = `${(s.dropRate * 100).toFixed(1)}%`;
  $('bw').textContent = s.bandwidthMbps == null ? '–' : `${s.bandwidthMbps.toFixed(1)} Mbps`;
  $('stalls').textContent = s.stalls1m;
  $('jumps').textContent = `(เด้ง LIVE แล้ว ${s.jumpsTotal} ครั้ง)`;

  const issues = $('issues');
  issues.replaceChildren();
  const list = s.issues.length ? s.issues
    : [{ level: 'good', title: 'ทุกอย่างปกติ ✓', fix: 'ถ้าไลฟ์ค้าง ระบบจะกด LIVE ให้อัตโนมัติ' }];
  for (const it of list) {
    const li = document.createElement('li');
    li.className = it.level;
    const b = document.createElement('b'); b.textContent = it.title;
    const p = document.createElement('p'); p.textContent = it.fix;
    li.append(b, p);
    if (it.action) {
      const btn = document.createElement('button');
      btn.textContent = ACTION_LABEL[it.action];
      btn.onclick = () => send(it.action);
      li.append(btn);
    }
    issues.append(li);
  }

  const log = $('log');
  log.replaceChildren();
  for (const e of s.log) {
    const li = document.createElement('li');
    const t = document.createElement('time'); t.textContent = fmtTime(e.t);
    li.append(t, e.msg);
    log.append(li);
  }
  if (!s.log.length) log.innerHTML = '<li>ยังไม่มีเหตุการณ์</li>';
}

async function poll() {
  const res = await send('getStats');
  render(res && res.stats);
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  tabId = tab ? tab.id : null;
  poll();
  setInterval(poll, 1000);
});
