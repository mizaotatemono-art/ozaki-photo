import {
  APPARATUS, RULESETS, SHAPES, DIFFICULTY, LANDMARK_INDEX as LM,
  toPixels, analyzeFrames, detectSegments, evaluateElement, analyzeLanding,
  frameIssues, computeScore, round1,
} from './scoring.js';

const MP_VERSION = '0.10.14';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL = (m) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/1/pose_landmarker_${m}.task`;

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

const state = {
  frames: [], // [{t, pts}]
  an: null, // analyzeFrames 結果
  candidates: [],
  elements: [],
  pendingStart: null,
  showOverlay: true,
  videoKey: null,
  opts: { apparatus: 'FX', ruleset: 'FIG', groups: {}, connection: 0, neutral: 0, stick: false, vaultD: 0, extraE: 0 },
};
let landmarker = null, landmarkerModel = null;
let nextId = 1;

// ---------- 初期化 ----------
for (const [k, a] of Object.entries(APPARATUS)) $('apparatus').add(new Option(a.name, k));
for (const [k, r] of Object.entries(RULESETS)) $('ruleset').add(new Option(r.name, k));
$('apparatus').onchange = () => { state.opts.apparatus = $('apparatus').value; state.opts.groups = {}; renderGroups(); refresh(); };
$('ruleset').onchange = () => { state.opts.ruleset = $('ruleset').value; refresh(); };
for (const id of ['connection', 'neutral', 'vaultD', 'extraE']) {
  $(id).oninput = () => { state.opts[id] = parseFloat($(id).value) || 0; refresh(); };
}
$('stick').onchange = () => { state.opts.stick = $('stick').checked; refresh(); };

$('cam').onchange = (e) => loadFile(e.target.files[0]);
$('pick').onchange = (e) => loadFile(e.target.files[0]);

function loadFile(file) {
  if (!file) return;
  video.src = URL.createObjectURL(file);
  video.hidden = false;
  $('empty').hidden = true;
  state.frames = []; state.an = null; state.candidates = [];
  state.videoKey = `gym:${file.name}:${file.size}`;
  restore();
  video.onloadedmetadata = () => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    $('analyze').disabled = false;
    setStatus(`動画 ${video.duration.toFixed(1)} 秒・${video.videoWidth}×${video.videoHeight}`);
    renderAll();
  };
}

function setStatus(s) { $('status').textContent = s; }

// ---------- 姿勢解析（MediaPipe Pose Landmarker） ----------
async function getLandmarker(model) {
  if (landmarker && landmarkerModel === model) return landmarker;
  setStatus('骨格モデルを読み込み中…');
  const { FilesetResolver, PoseLandmarker } = await import(`${MP_URL}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
  const make = (delegate) =>
    PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL_URL(model), delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.4,
      minPosePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
  try { landmarker = await make('GPU'); } catch { landmarker = await make('CPU'); }
  landmarkerModel = model;
  return landmarker;
}

function seek(t) {
  return new Promise((res) => {
    const done = () => { video.removeEventListener('seeked', done); res(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

$('analyze').onclick = async () => {
  const btn = $('analyze');
  btn.disabled = true;
  video.pause();
  try {
    const lm = await getLandmarker($('model').value);
    const fps = parseInt($('fps').value, 10);
    const dur = video.duration;
    const n = Math.floor(dur * fps) + 1;
    const frames = [];
    let ts = 0;
    for (let i = 0; i < n; i++) {
      const t = Math.min(dur - 0.001, i / fps);
      await seek(t);
      ts = Math.max(ts + 1, Math.round(t * 1000));
      const r = lm.detectForVideo(video, ts);
      const p = r.landmarks?.[0];
      frames.push({ t, pts: p ? toPixels(p, video.videoWidth, video.videoHeight) : null });
      if (i % 3 === 0) {
        $('bar').style.width = `${((i + 1) / n) * 100}%`;
        setStatus(`解析中… ${i + 1} / ${n} コマ`);
        drawOverlay(frames[frames.length - 1]);
      }
    }
    $('bar').style.width = '100%';
    setFrames(frames);
    const found = frames.filter((f) => f.pts).length;
    setStatus(`解析完了：${n} コマ中 ${found} コマで体を検出。候補 ${state.candidates.length} 件`);
    await seek(0);
  } catch (err) {
    console.error(err);
    setStatus(`解析できませんでした：${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
};

function setFrames(frames) {
  state.frames = frames;
  state.an = analyzeFrames(frames);
  state.candidates = detectSegments(state.an);
  for (const el of state.elements) reevaluate(el);
  renderAll();
}

// テストやデバッグ用：解析済みデータを直接渡せるように
window.__gym = { state, setFrames, refresh: () => renderAll() };

// ---------- 技 ----------
function makeElement(seg) {
  return {
    id: nextId++,
    name: seg.name || '技',
    start: seg.start,
    end: seg.end,
    value: seg.value || 'A',
    shape: seg.shape || 'other',
    kind: seg.kind || 'manual',
    isDismount: false,
    landingAuto: seg.kind === 'salto',
    manualDed: 0,
    enabled: true,
    auto: { items: [], total: 0 },
    landing: { items: [], total: 0 },
    autoDed: 0,
    landingDed: 0,
  };
}

function reevaluate(el) {
  if (state.an) {
    el.auto = evaluateElement(state.an, el);
    el.landing = el.landingAuto || el.isDismount ? analyzeLanding(state.an, el.end) : { items: [], total: 0 };
  }
  el.autoDed = el.auto.total;
  el.landingDed = el.landing.total;
}

function addElement(seg) {
  const el = makeElement(seg);
  reevaluate(el);
  state.elements.push(el);
  state.elements.sort((a, b) => a.start - b.start);
  return el;
}

$('markStart').onclick = () => {
  state.pendingStart = video.currentTime;
  $('markEnd').disabled = false;
  $('markInfo').textContent = `開始 ${fmt(state.pendingStart)} → 終わりで「ここまで」`;
};
$('markEnd').onclick = () => {
  let s = state.pendingStart, e = video.currentTime;
  if (s == null) return;
  if (e < s) [s, e] = [e, s];
  if (e - s < 0.05) e = s + 0.05;
  addElement({ start: s, end: e, name: `技${state.elements.length + 1}` });
  state.pendingStart = null;
  $('markEnd').disabled = true;
  $('markInfo').textContent = '';
  renderAll();
};
$('addAll').onclick = () => {
  for (const c of state.candidates) if (!isAdded(c)) addElement(c);
  renderAll();
};
$('clear').onclick = () => {
  if (!confirm('登録した技をすべて消しますか？')) return;
  state.elements = [];
  renderAll();
};

function isAdded(c) {
  return state.elements.some((e) => Math.abs(e.start - c.start) < 0.05 && Math.abs(e.end - c.end) < 0.05);
}

// ---------- 再生 ----------
$('play').onclick = () => (video.paused ? video.play() : video.pause());
video.onplay = () => ($('play').textContent = '⏸ 停止');
video.onpause = () => ($('play').textContent = '▶ 再生');
$('rate').onchange = () => (video.playbackRate = parseFloat($('rate').value));
video.addEventListener('loadeddata', () => (video.playbackRate = parseFloat($('rate').value)));
const step = () => 1 / (parseInt($('fps').value, 10) || 15);
$('back').onclick = () => { video.pause(); video.currentTime = Math.max(0, video.currentTime - step()); };
$('fwd').onclick = () => { video.pause(); video.currentTime = Math.min(video.duration, video.currentTime + step()); };
$('toggleOverlay').onclick = () => {
  state.showOverlay = !state.showOverlay;
  $('toggleOverlay').textContent = state.showOverlay ? '骨格 表示中' : '骨格 非表示';
  tick();
};
$('stage').onclick = (e) => { if (e.target === video) $('play').click(); };

function frameAt(t) {
  const f = state.frames;
  if (!f.length) return { frame: null, idx: -1 };
  let lo = 0, hi = f.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (f[m].t < t) lo = m + 1; else hi = m;
  }
  if (lo > 0 && Math.abs(f[lo - 1].t - t) < Math.abs(f[lo].t - t)) lo--;
  return { frame: f[lo], idx: lo };
}

let lastActive = null;
function tick() {
  const t = video.currentTime || 0;
  const { frame, idx } = frameAt(t);
  drawOverlay(frame, idx, t);
  updateScore(t);
  drawTimelineHead(t);
  const act = state.elements.find((e) => t >= e.start && t <= e.end);
  const id = act ? act.id : null;
  if (id !== lastActive) {
    document.querySelectorAll('.el').forEach((n) => n.classList.toggle('active', +n.dataset.id === id));
    lastActive = id;
  }
}
function loop() {
  tick();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------- 描画 ----------
const BONES = [
  [LM.LS, LM.RS], [LM.LS, LM.LE], [LM.LE, LM.LW], [LM.RS, LM.RE], [LM.RE, LM.RW],
  [LM.LS, LM.LH], [LM.RS, LM.RH], [LM.LH, LM.RH], [LM.LH, LM.LK], [LM.LK, LM.LA], [LM.RH, LM.RK], [LM.RK, LM.RA],
];
const COLOR = { 0: '#22c55e', 0.1: '#eab308', 0.3: '#f97316', 0.5: '#ef4444' };
const colorFor = (v) => (v >= 0.5 ? COLOR[0.5] : v >= 0.3 ? COLOR[0.3] : v > 0 ? COLOR[0.1] : COLOR[0]);
const LETTER_COLOR = (v) => {
  const x = DIFFICULTY[v] || 0.1;
  return `hsl(${220 - x * 220}, 75%, 48%)`;
};

function drawOverlay(frame, idx, t = video.currentTime || 0) {
  const W = canvas.width, H = canvas.height;
  if (!W) return;
  ctx.clearRect(0, 0, W, H);
  const u = Math.max(W, H) / 640; // 文字サイズの基準
  const active = state.elements.filter((e) => t >= e.start && t <= e.end);
  const el = active[0];
  const f = state.an && idx >= 0 ? state.an.feats[idx] : null;
  const issues = el && f ? frameIssues(f, el.shape) : [];
  const issueOf = (k) => issues.find((x) => x.key === k)?.value || 0;

  if (state.showOverlay && frame?.pts) {
    const p = frame.pts;
    ctx.lineCap = 'round';
    const partKey = (a, b) => {
      if ([LM.LH, LM.RH].includes(a) && [LM.LK, LM.RK].includes(b)) return 'hip';
      if ([LM.LK, LM.RK].includes(a)) return 'knee';
      if ([LM.LE, LM.RE].includes(a) || [LM.LE, LM.RE].includes(b)) return 'elbow';
      return null;
    };
    for (const [a, b] of BONES) {
      if (p[a].v < 0.3 || p[b].v < 0.3) continue;
      const k = partKey(a, b);
      const v = k ? issueOf(k) : 0;
      ctx.strokeStyle = colorFor(v);
      ctx.lineWidth = 5 * u;
      ctx.beginPath(); ctx.moveTo(p[a].x, p[a].y); ctx.lineTo(p[b].x, p[b].y); ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    for (const k of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
      if (p[k].v < 0.3) continue;
      ctx.beginPath(); ctx.arc(p[k].x, p[k].y, 4 * u, 0, 7); ctx.fill();
    }
    if (f) {
      // 関節の角度
      const label = (pt, txt, v) => {
        ctx.font = `bold ${13 * u}px sans-serif`;
        const w = ctx.measureText(txt).width + 8 * u;
        ctx.fillStyle = 'rgba(0,0,0,.6)';
        ctx.fillRect(pt.x + 8 * u, pt.y - 10 * u, w, 18 * u);
        ctx.fillStyle = colorFor(v);
        ctx.fillText(txt, pt.x + 12 * u, pt.y + 4 * u);
      };
      const ks = p[LM.LK].v >= p[LM.RK].v ? LM.LK : LM.RK;
      const hs = p[LM.LH].v >= p[LM.RH].v ? LM.LH : LM.RH;
      const es = p[LM.LE].v >= p[LM.RE].v ? LM.LE : LM.RE;
      if (f.knee != null) label(p[ks], `膝 ${Math.round(f.knee)}°`, issueOf('knee'));
      if (f.hip != null) label(p[hs], `腰 ${Math.round(f.hip)}°`, issueOf('hip'));
      if (f.elbow != null) label(p[es], `肘 ${Math.round(f.elbow)}°`, issueOf('elbow'));
      // 倒立・静止技では体の線と垂直線
      if (el && (el.shape === 'handstand' || el.shape === 'hold')) {
        ctx.setLineDash([8 * u, 6 * u]);
        ctx.strokeStyle = 'rgba(255,255,255,.8)';
        ctx.lineWidth = 2 * u;
        ctx.beginPath(); ctx.moveTo(f.S.x, f.S.y + 40 * u); ctx.lineTo(f.S.x, f.S.y - f.bodyLen * 1.1); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = colorFor(issueOf('line'));
        ctx.lineWidth = 3 * u;
        ctx.beginPath(); ctx.moveTo(f.S.x, f.S.y); ctx.lineTo(f.A.x, f.A.y); ctx.stroke();
        const dev = f.inverted ? f.lineDevInverted : f.lineDevUpright;
        label({ x: f.A.x, y: f.A.y }, `垂直から ${Math.round(dev)}°`, issueOf('line'));
      }
    }
  }

  // 上：今の技
  const pad = 10 * u;
  let y = pad;
  const box = (lines, bg) => {
    ctx.font = `bold ${16 * u}px sans-serif`;
    const lh = 21 * u;
    const w = Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 2 * pad;
    ctx.fillStyle = bg;
    roundRect(pad, y, Math.min(w, W - 2 * pad), lines.length * lh + pad, 8 * u);
    lines.forEach((l, i) => {
      ctx.font = `${l.bold ? 'bold ' : ''}${(l.size || 16) * u}px sans-serif`;
      ctx.fillStyle = l.color || '#fff';
      ctx.fillText(l.text, 2 * pad, y + pad / 2 + lh * (i + 0.8));
    });
    y += lines.length * lh + pad + 6 * u;
  };
  if (el) {
    const lines = [
      { text: `${el.name}　難度 ${el.value}（${DIFFICULTY[el.value].toFixed(1)}）${el.isDismount ? '・終末技' : ''}`, bold: true },
      { text: `形：${SHAPES[el.shape].name}`, size: 13, color: '#cbd5e1' },
    ];
    for (const it of issues) lines.push({ text: `▲ ${it.label}  −${it.value.toFixed(1)}`, size: 13, color: colorFor(it.value) });
    box(lines, 'rgba(15,23,42,.78)');
  }
  // 着地直後
  const landed = state.an
    ? state.elements.find((e) => e.enabled && (e.landingAuto || e.isDismount) && t > e.end && t <= e.end + 1.5)
    : null;
  if (landed) {
    const lines = [{ text: `着地（${landed.name}）`, bold: true }];
    if (landed.landing.items.length)
      for (const it of landed.landing.items) lines.push({ text: `▲ ${it.label}  −${it.value.toFixed(1)}`, size: 13, color: colorFor(it.value) });
    else lines.push({ text: '◎ 着地が止まっています', size: 13, color: COLOR[0] });
    box(lines, 'rgba(15,23,42,.78)');
  }

  // 下：その時点までの得点
  const s = computeScore(state.elements, state.opts, t);
  const txt = `D ${s.D.toFixed(3)}   E ${s.E.toFixed(3)}   計 ${s.total.toFixed(3)}`;
  ctx.font = `bold ${17 * u}px sans-serif`;
  const tw = ctx.measureText(txt).width + 2 * pad;
  ctx.fillStyle = 'rgba(37,99,235,.88)';
  roundRect(W - tw - pad, H - 34 * u - pad, tw, 34 * u, 8 * u);
  ctx.fillStyle = '#fff';
  ctx.fillText(txt, W - tw, H - pad - 11 * u);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill();
}

// ---------- タイムライン ----------
function renderTimeline() {
  const tl = $('timeline');
  tl.innerHTML = '';
  const dur = video.duration || 1;
  for (const c of state.candidates) {
    const d = document.createElement('div');
    d.className = 'cand';
    d.style.left = `${(c.start / dur) * 100}%`;
    d.style.width = `${Math.max(0.5, ((c.end - c.start) / dur) * 100)}%`;
    tl.appendChild(d);
  }
  for (const e of state.elements) {
    const d = document.createElement('div');
    d.className = 'seg';
    d.style.left = `${(e.start / dur) * 100}%`;
    d.style.width = `${Math.max(1, ((e.end - e.start) / dur) * 100)}%`;
    d.style.background = LETTER_COLOR(e.value);
    d.textContent = e.value;
    tl.appendChild(d);
  }
  const h = document.createElement('div');
  h.className = 'head';
  h.id = 'tlhead';
  tl.appendChild(h);
}
function drawTimelineHead(t) {
  const h = $('tlhead');
  if (h && video.duration) h.style.left = `${(t / video.duration) * 100}%`;
}
$('timeline').onclick = (e) => {
  if (!video.duration) return;
  const r = $('timeline').getBoundingClientRect();
  video.currentTime = ((e.clientX - r.left) / r.width) * video.duration;
};

// ---------- 一覧 ----------
function fmt(t) { return `${t.toFixed(2)}秒`; }

function renderCandidates() {
  const ul = $('cands');
  ul.innerHTML = '';
  $('candBox').hidden = !state.candidates.length;
  for (const c of state.candidates) {
    const li = document.createElement('li');
    const added = isAdded(c);
    li.innerHTML = `<span><span class="time">${fmt(c.start)}–${fmt(c.end)}</span> ${c.name}</span>`;
    li.querySelector('.time').onclick = () => (video.currentTime = c.start);
    const b = document.createElement('button');
    b.textContent = added ? '登録済み' : '登録';
    b.disabled = added;
    b.onclick = () => { addElement(c); renderAll(); };
    li.appendChild(b);
    ul.appendChild(li);
  }
}

function dedClass(v) { return v >= 0.5 ? 'd05' : v >= 0.3 ? 'd03' : 'd01'; }

function renderElements() {
  const box = $('elements');
  box.innerHTML = '';
  const app = APPARATUS[state.opts.apparatus];
  for (const el of state.elements) {
    const d = document.createElement('div');
    d.className = 'el';
    d.dataset.id = el.id;
    const letters = Object.keys(DIFFICULTY).map((k) => `<option value="${k}" ${k === el.value ? 'selected' : ''}>${k}（${DIFFICULTY[k].toFixed(1)}）</option>`).join('');
    const shapes = Object.entries(SHAPES).map(([k, s]) => `<option value="${k}" ${k === el.shape ? 'selected' : ''}>${s.name}</option>`).join('');
    const ded = [...el.auto.items.map((x) => ({ ...x, src: '姿勢' })), ...el.landing.items.map((x) => ({ ...x, src: '着地' }))];
    d.innerHTML = `
      <div class="top">
        <input type="text" class="nm" value="${escapeHtml(el.name)}" aria-label="技の名前">
        <select class="val" aria-label="難度">${letters}</select>
        <select class="shp" aria-label="形">${shapes}</select>
      </div>
      <div class="top" style="margin-top:6px">
        <span class="time">${fmt(el.start)}–${fmt(el.end)}</span>
        ${app.hasDismount ? `<label><input type="checkbox" class="dis" ${el.isDismount ? 'checked' : ''}> ${app.dismountLabel}</label>` : ''}
        <label><input type="checkbox" class="land" ${el.landingAuto ? 'checked' : ''}> 着地を判定</label>
        <label><input type="checkbox" class="en" ${el.enabled ? 'checked' : ''}> 採点に含める</label>
        <label>調整 <input type="number" class="man" step="0.1" value="${el.manualDed}" style="width:70px"></label>
        <button class="del" aria-label="削除">🗑</button>
      </div>
      <div class="ded">
        ${ded.length ? `<ul>${ded.map((x) => `<li class="${dedClass(x.value)}">${x.src}：${x.label} −${x.value.toFixed(1)}</li>`).join('')}</ul>` : `<span class="hint">${state.an ? '自動判定の減点なし' : '解析すると姿勢の減点が出ます'}</span>`}
        ${el.auto.notRecognized ? '<div class="warn">角度のずれが45°を超えています。技として認められない可能性があります。</div>' : ''}
        <span class="chip">実施減点 −${round1(el.autoDed + el.landingDed + (el.manualDed || 0)).toFixed(1)}</span>
      </div>`;
    const q = (s) => d.querySelector(s);
    q('.nm').oninput = (e) => { el.name = e.target.value; save(); };
    q('.val').onchange = (e) => { el.value = e.target.value; renderTimeline(); refresh(); };
    q('.shp').onchange = (e) => { el.shape = e.target.value; reevaluate(el); renderAll(); };
    q('.time').onclick = () => { video.pause(); video.currentTime = el.start; };
    if (q('.dis')) q('.dis').onchange = (e) => {
      if (e.target.checked) state.elements.forEach((x) => (x.isDismount = false));
      el.isDismount = e.target.checked;
      reevaluate(el); renderAll();
    };
    q('.land').onchange = (e) => { el.landingAuto = e.target.checked; reevaluate(el); renderAll(); };
    q('.en').onchange = (e) => { el.enabled = e.target.checked; refresh(); };
    q('.man').oninput = (e) => { el.manualDed = parseFloat(e.target.value) || 0; refresh(); };
    q('.del').onclick = () => { state.elements = state.elements.filter((x) => x !== el); renderAll(); };
    box.appendChild(d);
  }
  lastActive = null;
}

function renderGroups() {
  const app = APPARATUS[state.opts.apparatus];
  $('vaultBox').hidden = !app.vault;
  const g = $('groupsBox');
  if (app.vault) { g.innerHTML = '<p class="hint">跳馬は跳越技ごとの難度点（Dスコア）を入力し、姿勢・着地の減点で Eスコアを出します。</p>'; return; }
  const val = RULESETS[state.opts.ruleset].groupValue;
  g.innerHTML = `<div class="hint" style="margin:0 0 4px">技のグループ要求（満たしたものにチェック・各 ${val.toFixed(1)}）</div>` +
    app.groups.map((x) => `<label style="margin-right:12px"><input type="checkbox" data-g="${x}" ${state.opts.groups[x] ? 'checked' : ''}> グループ${x}</label>`).join('');
  g.querySelectorAll('input').forEach((i) => (i.onchange = () => { state.opts.groups[i.dataset.g] = i.checked; refresh(); }));
}

function updateScore(t) {
  const s = computeScore(state.elements, state.opts);
  $('sD').textContent = s.D.toFixed(3);
  $('sE').textContent = s.E.toFixed(3);
  $('sN').textContent = s.ND.toFixed(3);
  $('sT').textContent = s.total.toFixed(3);
  return s;
}

function renderBreakdown() {
  const s = computeScore(state.elements, state.opts);
  const p = s.dParts;
  const rows = [];
  const app = APPARATUS[state.opts.apparatus];
  if (app.vault) rows.push(['跳馬の難度点', p.difficulty]);
  else {
    rows.push([`難度点（数える技 ${p.counted.length} / ${RULESETS[state.opts.ruleset].counted}）：${p.counted.map((e) => e.value).join(' ') || '—'}`, p.difficulty]);
    rows.push(['グループ要求', p.groups]);
    if (app.dismountGroup) rows.push(['終末技グループ（上限0.5）', p.dismountGroup]);
    rows.push(['組合せ加点', p.connection]);
    rows.push(['着地の加点', p.stick]);
  }
  rows.push(['<b>Dスコア</b>', s.D]);
  for (const it of s.eItems) rows.push([`実施減点：${escapeHtml(it.name)}`, -it.value]);
  if (state.opts.extraE) rows.push(['その他の実施減点', -state.opts.extraE]);
  rows.push(['<b>Eスコア</b>（10.0 − 減点）', s.E]);
  if (s.ND) rows.push(['ニュートラル減点', -s.ND]);
  rows.push(['<b>決定点</b>', s.total]);
  $('breakdown').innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${(+b).toFixed(3)}</td></tr>`).join('');
  return s;
}

$('copy').onclick = async () => {
  const s = renderBreakdown();
  const app = APPARATUS[state.opts.apparatus];
  const lines = [`【${app.name}】D ${s.D.toFixed(3)} / E ${s.E.toFixed(3)} / ND ${s.ND.toFixed(3)} / 決定点 ${s.total.toFixed(3)}`];
  for (const e of state.elements.filter((x) => x.enabled)) {
    const ded = round1(e.autoDed + e.landingDed + (e.manualDed || 0));
    lines.push(`・${e.name} ${e.value}${e.isDismount ? '（終末技）' : ''} 減点 −${ded.toFixed(1)}`);
  }
  lines.push('※姿勢解析による目安');
  try { await navigator.clipboard.writeText(lines.join('\n')); alert('コピーしました'); } catch { prompt('コピーしてください', lines.join('\n')); }
};

function refresh() {
  for (const el of state.elements) { el.autoDed = el.auto.total; el.landingDed = el.landing.total; }
  renderBreakdown();
  updateScore();
  renderTimeline();
  save();
}
function renderAll() {
  renderGroups();
  renderCandidates();
  renderElements();
  refresh();
}

// ---------- 保存（この端末のみ） ----------
function save() {
  if (!state.videoKey) return;
  try {
    localStorage.setItem(state.videoKey, JSON.stringify({ elements: state.elements, opts: state.opts }));
  } catch {}
}
function restore() {
  state.elements = [];
  try {
    const d = JSON.parse(localStorage.getItem(state.videoKey) || 'null');
    if (d) {
      state.elements = d.elements || [];
      Object.assign(state.opts, d.opts || {});
      nextId = Math.max(1, ...state.elements.map((e) => e.id + 1));
      $('apparatus').value = state.opts.apparatus;
      $('ruleset').value = state.opts.ruleset;
      for (const id of ['connection', 'neutral', 'vaultD', 'extraE']) $(id).value = state.opts[id] || 0;
      $('stick').checked = !!state.opts.stick;
    }
  } catch {}
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

renderAll();
