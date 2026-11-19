// 器械体操 採点ロジック（姿勢解析・技の候補検出・D/E スコア計算）
// 画面や MediaPipe に依存しない純粋な関数だけをまとめています。
//
// 採点の考え方は FIG（国際体操連盟）2025–2028 年版採点規則と、それを訳した
// 日本体操協会の採点規則に沿っています（数値は「設定」で変更できます）。
//   決定点 = Dスコア（難度点 + 要求グループ + 組合せ加点）
//          + Eスコア（10.0 − 実施減点）
//          − ニュートラル減点（ライン・時間など）

export const DIFFICULTY = { A: 0.1, B: 0.2, C: 0.3, D: 0.4, E: 0.5, F: 0.6, G: 0.7, H: 0.8, I: 0.9, J: 1.0 };

export const APPARATUS = {
  FX: { name: '床', dismountLabel: '最後の技', groups: ['I', 'II', 'III'], hasDismount: true, dismountGroup: false },
  PH: { name: 'あん馬', dismountLabel: '終末技', groups: ['I', 'II', 'III'], hasDismount: true, dismountGroup: true },
  SR: { name: 'つり輪', dismountLabel: '終末技', groups: ['I', 'II', 'III'], hasDismount: true, dismountGroup: true },
  VT: { name: '跳馬', dismountLabel: '', groups: [], hasDismount: false, vault: true },
  PB: { name: '平行棒', dismountLabel: '終末技', groups: ['I', 'II', 'III'], hasDismount: true, dismountGroup: true },
  HB: { name: '鉄棒', dismountLabel: '終末技', groups: ['I', 'II', 'III'], hasDismount: true, dismountGroup: true },
  // 女子
  WVT: { name: '跳馬（女子）', groups: [], hasDismount: false, vault: true, women: true },
  UB: { name: '段違い平行棒', dismountLabel: '終末技', groups: ['1', '2', '3', '4'], hasDismount: true, women: true },
  BB: { name: '平均台', dismountLabel: '終末技', groups: ['1', '2', '3', '4'], hasDismount: true, women: true },
  WFX: { name: '床（女子）', dismountLabel: '最後の宙返り', groups: ['1', '2', '3', '4'], hasDismount: true, women: true },
};

export const RULESETS = {
  FIG: { name: 'FIG 2025–2028（一般・シニア）', counted: 8, groupValue: 0.5, dismountCap: 0.5 },
  U15: { name: 'ジュニア（6技＋終末技）', counted: 7, groupValue: 0.5, dismountCap: 0.5 },
};

// 技の形（姿勢）— 減点のチェック項目が変わります
export const SHAPES = {
  stretched: { name: '伸身', checks: ['knee', 'hip', 'split'] },
  piked: { name: '屈身', checks: ['knee', 'split'] },
  tucked: { name: '抱え込み', checks: [] },
  handstand: { name: '倒立', checks: ['knee', 'hip', 'elbow', 'line', 'split'] },
  hold: { name: '静止技（力技）', checks: ['elbow', 'hold', 'line'] },
  support: { name: '支持・振動', checks: ['knee', 'elbow', 'split'] },
  other: { name: 'その他', checks: [] },
};

// 実施減点の段階（小 0.1 / 中 0.3 / 大 0.5 / 落下 1.0）
export const DEDUCTION_TABLE = {
  // 曲がり（腕・脚・体）: 理想の直線からのずれ（度）
  bend: [
    { min: 20, value: 0.1, label: 'わずかに曲がり' },
    { min: 45, value: 0.3, label: '曲がり（中）' },
    { min: 90, value: 0.5, label: '大きく曲がり' },
  ],
  // 倒立・静止技の角度のずれ（度）
  line: [
    { min: 5, value: 0.1, label: '〜15°のずれ' },
    { min: 15, value: 0.3, label: '16〜30°のずれ' },
    { min: 30, value: 0.5, label: '31〜45°のずれ' },
    { min: 45, value: 0.5, label: '45°超（技不認定の可能性）', notRecognized: true },
  ],
  // 脚の開き（左右の脚の角度）
  split: [
    { min: 20, value: 0.1, label: '脚の開き（小）' },
    { min: 45, value: 0.3, label: '脚の開き（大）' },
  ],
  holdSeconds: 2.0,
  holdShort: 0.3,
  landing: {
    smallStep: 0.1, // 小さく1歩・跳ねる（1回ごと）
    smallStepMax: 0.3,
    largeStep: 0.3, // 大きな1歩・跳ね（肩幅以上）
    handTouch: 0.3, // 手が床に触れる
    handSupport: 0.5, // 手で体を支える
    fall: 1.0, // 落下・尻もち
  },
  stickBonus: 0.1, // 2025年版：着地をピタリと止めた場合の加点（Dスコア）
};

const LM = { NOSE: 0, LS: 11, RS: 12, LE: 13, RE: 14, LW: 15, RW: 16, LH: 23, RH: 24, LK: 25, RK: 26, LA: 27, RA: 28 };

// ---------- 幾何 ----------
function angleAt(a, b, c) {
  // b を頂点とする角度（度, 0–180）
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!d) return null;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d));
  return (Math.acos(cos) * 180) / Math.PI;
}
function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v, b.v) };
}
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function wrap180(d) {
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}
function percentile(arr, p) {
  const a = arr.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[i];
}

// MediaPipe のランドマーク（0–1 正規化）をピクセル座標に
export function toPixels(landmarks, w, h) {
  return landmarks.map((p) => ({ x: p.x * w, y: p.y * h, v: p.visibility ?? 1 }));
}

// 1フレーム分の特徴量（横から撮影した前提：体の矢状面の角度がそのまま見える）
export function frameFeatures(p) {
  if (!p) return null;
  const side = (l, r) => (p[l].v >= p[r].v ? l : r);
  const S = mid(p[LM.LS], p[LM.RS]);
  const H = mid(p[LM.LH], p[LM.RH]);
  const A = mid(p[LM.LA], p[LM.RA]);
  const kneeL = angleAt(p[LM.LH], p[LM.LK], p[LM.LA]);
  const kneeR = angleAt(p[LM.RH], p[LM.RK], p[LM.RA]);
  const ks = side(LM.LK, LM.RK);
  // 見えている側を優先しつつ、両方見えていれば曲がりの大きい方を採用
  let knee;
  if (p[LM.LK].v > 0.5 && p[LM.RK].v > 0.5) knee = Math.min(kneeL, kneeR);
  else knee = ks === LM.LK ? kneeL : kneeR;
  const hipSide = side(LM.LH, LM.RH);
  const hip =
    hipSide === LM.LH ? angleAt(p[LM.LS], p[LM.LH], p[LM.LK]) : angleAt(p[LM.RS], p[LM.RH], p[LM.RK]);
  const elbowL = angleAt(p[LM.LS], p[LM.LE], p[LM.LW]);
  const elbowR = angleAt(p[LM.RS], p[LM.RE], p[LM.RW]);
  let elbow;
  if (p[LM.LE].v > 0.5 && p[LM.RE].v > 0.5) elbow = Math.min(elbowL, elbowR);
  else elbow = side(LM.LE, LM.RE) === LM.LE ? elbowL : elbowR;
  const split = angleAt(p[LM.LA], H, p[LM.RA]);
  // 体幹の向き：腰→肩 のベクトルが真上から何度回っているか（符号付き）
  const theta = (Math.atan2(S.x - H.x, -(S.y - H.y)) * 180) / Math.PI;
  // 体の線（肩→足首）が真上・真下からどれだけずれているか
  const lineAng = (Math.atan2(A.x - S.x, -(A.y - S.y)) * 180) / Math.PI; // 足首が肩の真上なら 0
  const lineDevInverted = Math.abs(wrap180(lineAng));
  const lineDevUpright = Math.abs(wrap180(lineAng - 180));
  const W = mid(p[LM.LW], p[LM.RW]);
  return {
    S, H, A, W,
    knee, kneeL, kneeR, hip, elbow, elbowL, elbowR, split, theta,
    lineDevInverted, lineDevUpright,
    inverted: Math.abs(theta) > 120,
    bodyLen: dist(S, A),
    vis: Math.min(S.v, H.v),
  };
}

// 全フレームの特徴量・回転・静止度を計算
// frames: [{t, pts}]（pts は toPixels 済み、検出なしは null）
export function analyzeFrames(frames) {
  const feats = frames.map((f) => (f.pts ? frameFeatures(f.pts) : null));
  const lens = feats.filter(Boolean).map((f) => f.bodyLen);
  const L = percentile(lens, 75) || 1; // 体の長さ（スケール）
  const ankleYs = feats.filter(Boolean).map((f) => Math.max(f.A.y, f.H.y));
  const ground = percentile(ankleYs, 95) ?? 0;

  // 回転（体幹の向きを連続化）
  let acc = null, prevTheta = null;
  const rot = feats.map((f) => {
    if (!f) return null;
    if (prevTheta == null) acc = f.theta;
    else acc += wrap180(f.theta - prevTheta);
    prevTheta = f.theta;
    return acc;
  });

  // 動きの大きさ（体の長さ / 秒）
  const speed = feats.map((f, i) => {
    if (!f || i === 0 || !feats[i - 1]) return null;
    const dt = frames[i].t - frames[i - 1].t || 1 / 30;
    const g = feats[i - 1];
    const m = Math.max(dist(f.S, g.S), dist(f.H, g.H), dist(f.A, g.A), dist(f.W, g.W));
    return m / L / dt;
  });

  return { feats, L, ground, rot, speed, times: frames.map((f) => f.t) };
}

// ---------- 技の候補を自動検出 ----------
export function detectSegments(an, opts = {}) {
  const { feats, rot, speed, times, L, ground } = an;
  const n = times.length;
  const out = [];
  const fps = n > 1 ? (n - 1) / (times[n - 1] - times[0] || 1) : 30;
  const omegaMin = opts.omegaMin ?? 220; // 度/秒

  // 1) 宙返り・回転：体幹の回転速度が速い区間
  const omega = rot.map((r, i) => {
    if (r == null) return null;
    let j = i - 1;
    while (j >= 0 && rot[j] == null && i - j < fps * 0.3) j--;
    if (j < 0 || rot[j] == null) return null;
    return (r - rot[j]) / (times[i] - times[j]);
  });
  let i = 0;
  while (i < n) {
    if (omega[i] != null && Math.abs(omega[i]) > omegaMin) {
      const sign = Math.sign(omega[i]);
      let j = i, gap = 0;
      while (j + 1 < n) {
        const o = omega[j + 1];
        if (o == null) {
          if (++gap > fps * 0.3) break; // 空中で検出が途切れても 0.3 秒までは繋ぐ
        } else if (Math.sign(o) === sign && Math.abs(o) > omegaMin * 0.5) {
          gap = 0;
        } else break;
        j++;
      }
      while (j > i && rot[j] == null) j--;
      let si = i - 1;
      while (si > 0 && rot[si] == null) si--;
      si = Math.max(0, si);
      const total = rot[j] != null && rot[si] != null ? Math.abs(rot[j] - rot[si]) : 0;
      if (total >= 250) {
        const turns = Math.round((total / 360) * 2) / 2;
        // 体の形の推定
        const seg = feats.slice(si, j + 1).filter(Boolean);
        // 空中で最も体を曲げた時の角度で形を判定
        const kneeMed = percentile(seg.map((f) => f.knee), 25);
        const hipMed = percentile(seg.map((f) => f.hip), 25);
        let shape = 'stretched';
        if (kneeMed != null && kneeMed < 120) shape = 'tucked';
        else if (hipMed != null && hipMed < 130) shape = 'piked';
        // 進行方向と回転方向から前方／後方を判定（横からの撮影が前提）
        const fa = feats[si], fb = feats[j];
        const travel = fa && fb ? fb.H.x - fa.H.x : 0;
        const dir = Math.abs(travel) > 0.1 * L ? (Math.sign(travel) === sign ? '前方' : '後方') : '';
        out.push({
          kind: 'salto',
          start: times[si],
          end: times[j],
          turns,
          shape,
          name: `${dir}${turnsLabel(turns)}（${SHAPES[shape].name}）`,
        });
      }
      i = j + 1;
    } else i++;
  }

  // 2) 倒立・静止：逆さまで動きが小さい / 支持で静止している区間
  i = 0;
  const still = (k) => speed[k] != null && speed[k] < 0.35;
  while (i < n) {
    const f = feats[i];
    const standing = f && !f.inverted && Math.abs(f.theta) < 25 && f.A.y > ground - 0.08 * L;
    if (f && still(i) && !standing) {
      let j = i;
      while (j + 1 < n && feats[j + 1] && still(j + 1) && feats[j + 1].inverted === f.inverted) j++;
      const dur = times[j] - times[i];
      if (dur >= 0.8) {
        out.push({
          kind: f.inverted ? 'handstand' : 'hold',
          start: times[i],
          end: times[j],
          shape: f.inverted ? 'handstand' : 'hold',
          name: f.inverted ? `倒立（${dur.toFixed(1)}秒）` : `静止（${dur.toFixed(1)}秒）`,
        });
      }
      i = j + 1;
    } else i++;
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function turnsLabel(t) {
  if (t <= 0.5) return '半回転';
  if (t === 1) return '宙返り';
  if (t === 2) return '2回宙返り';
  if (t === 3) return '3回宙返り';
  return `${t}回転`;
}

// ---------- 実施減点（姿勢から自動） ----------
function band(table, dev) {
  let hit = null;
  for (const b of table) if (dev >= b.min) hit = b;
  return hit;
}

// 1フレームで目立つ減点（再生中の表示用）
export function frameIssues(f, shape) {
  const res = [];
  if (!f) return res;
  const checks = SHAPES[shape]?.checks ?? [];
  const add = (key, dev, table, what) => {
    const b = band(table, dev);
    if (b) res.push({ key, dev, value: b.value, label: `${what}：${b.label}（${Math.round(dev)}°）`, notRecognized: b.notRecognized });
  };
  if (checks.includes('knee') && f.knee != null) add('knee', 180 - f.knee, DEDUCTION_TABLE.bend, '膝');
  if (checks.includes('hip') && f.hip != null) add('hip', 180 - f.hip, DEDUCTION_TABLE.bend, '腰');
  if (checks.includes('elbow') && f.elbow != null) add('elbow', 180 - f.elbow, DEDUCTION_TABLE.bend, '肘');
  if (checks.includes('split') && f.split != null) add('split', f.split, DEDUCTION_TABLE.split, '脚');
  if (checks.includes('line')) {
    const dev = f.inverted ? f.lineDevInverted : Math.min(f.lineDevUpright, f.lineDevInverted, Math.abs(90 - f.lineDevUpright));
    add('line', dev, DEDUCTION_TABLE.line, f.inverted ? '倒立の角度' : '姿勢の角度');
  }
  return res;
}

// 技の区間全体で評価（一瞬のブレを拾わないよう 80 パーセンタイルで判定）
export function evaluateElement(an, el) {
  const idx = [];
  an.times.forEach((t, k) => {
    if (t >= el.start - 1e-6 && t <= el.end + 1e-6 && an.feats[k]) idx.push(k);
  });
  const result = { items: [], total: 0, notRecognized: false };
  if (!idx.length) return result;
  const checks = SHAPES[el.shape]?.checks ?? [];
  const pick = (fn) => percentile(idx.map((k) => fn(an.feats[k])), 80);
  const add = (key, dev, table, what) => {
    if (dev == null) return;
    const b = band(table, dev);
    if (b) {
      result.items.push({ key, value: b.value, label: `${what}：${b.label}（約${Math.round(dev)}°）` });
      if (b.notRecognized) result.notRecognized = true;
    }
  };
  if (checks.includes('knee')) add('knee', pick((f) => (f.knee == null ? null : 180 - f.knee)), DEDUCTION_TABLE.bend, '膝の曲がり');
  if (checks.includes('hip')) add('hip', pick((f) => (f.hip == null ? null : 180 - f.hip)), DEDUCTION_TABLE.bend, '腰の曲がり');
  if (checks.includes('elbow')) add('elbow', pick((f) => (f.elbow == null ? null : 180 - f.elbow)), DEDUCTION_TABLE.bend, '肘の曲がり');
  if (checks.includes('split')) add('split', pick((f) => f.split), DEDUCTION_TABLE.split, '脚の開き');
  if (checks.includes('line')) {
    const dev = pick((f) =>
      f.inverted ? f.lineDevInverted : Math.min(f.lineDevUpright, Math.abs(90 - f.lineDevUpright))
    );
    add('line', dev, DEDUCTION_TABLE.line, el.shape === 'handstand' ? '倒立の角度' : '静止姿勢の角度');
  }
  if (checks.includes('hold')) {
    const dur = el.end - el.start;
    if (dur < DEDUCTION_TABLE.holdSeconds) {
      result.items.push({ key: 'hold', value: DEDUCTION_TABLE.holdShort, label: `静止が2秒未満（${dur.toFixed(1)}秒）` });
    }
  }
  result.total = round1(result.items.reduce((s, x) => s + x.value, 0));
  return result;
}

// ---------- 着地の解析 ----------
export function analyzeLanding(an, endTime, windowSec = 1.5) {
  const { feats, times, L, ground } = an;
  const idx = [];
  times.forEach((t, k) => {
    if (t > endTime && t <= endTime + windowSec && feats[k]) idx.push(k);
  });
  const items = [];
  if (idx.length < 3) return { items, total: 0, stuck: false };
  // 足（足首中点）の横移動から歩数を数える
  let steps = 0, maxShift = 0;
  const x0 = feats[idx[0]].A.x;
  let anchor = x0;
  for (const k of idx) {
    const x = feats[k].A.x;
    maxShift = Math.max(maxShift, Math.abs(x - x0) / L);
    if (Math.abs(x - anchor) / L > 0.12) {
      steps++;
      anchor = x;
    }
  }
  const lowestHip = Math.max(...idx.map((k) => feats[k].H.y));
  const lowestWrist = Math.max(...idx.map((k) => feats[k].W.y));
  const D = DEDUCTION_TABLE.landing;
  if (ground - lowestHip < 0.12 * L) {
    items.push({ key: 'fall', value: D.fall, label: '落下・尻もちの可能性' });
  } else if (ground - lowestWrist < 0.06 * L) {
    items.push({ key: 'hand', value: D.handTouch, label: '手が床に触れた可能性' });
  }
  if (maxShift > 0.5) items.push({ key: 'large', value: D.largeStep, label: `大きな1歩（約${(maxShift).toFixed(1)}×身長）` });
  else if (steps > 0)
    items.push({ key: 'steps', value: Math.min(D.smallStepMax, steps * D.smallStep), label: `小さな歩・跳ね ${steps}回` });
  const total = round1(items.reduce((s, x) => s + x.value, 0));
  return { items, total, stuck: items.length === 0 };
}

// ---------- 得点計算 ----------
export function round1(x) {
  return Math.round(x * 1000) / 1000;
}

// elements: [{value:'C', isDismount, start, end, autoDed, landingDed, manualDed, enabled}]
// opts: {apparatus, ruleset, groups:{I:true,...}, connection, neutral, stick, vaultD, extraE}
export function computeScore(elements, opts, uptoTime = Infinity) {
  const app = APPARATUS[opts.apparatus] || APPARATUS.FX;
  const rs = RULESETS[opts.ruleset] || RULESETS.FIG;
  const els = elements.filter((e) => e.enabled !== false && e.start <= uptoTime);

  // 実施減点
  let eDed = 0;
  const eItems = [];
  for (const e of els) {
    const done = e.end <= uptoTime;
    if (!done) continue;
    const v = (e.autoDed || 0) + (e.landingDed || 0) + (e.manualDed || 0);
    if (v) eItems.push({ name: e.name, value: v });
    eDed += v;
  }
  eDed += opts.extraE || 0;
  const E = Math.max(0, round1(10 - eDed));

  let D = 0;
  const dParts = { difficulty: 0, groups: 0, dismountGroup: 0, connection: 0, stick: 0, counted: [] };
  if (app.vault) {
    D = opts.vaultD || 0;
    dParts.difficulty = D;
  } else {
    const val = (e) => DIFFICULTY[e.value] || 0;
    const done = els.filter((e) => e.end <= uptoTime);
    const dis = app.hasDismount ? done.filter((e) => e.isDismount).sort((a, b) => val(b) - val(a))[0] : null;
    // 終末技は必ず数える（床は最後の技も他と同じ扱いで上位から数える）
    const forceDis = dis && (app.dismountGroup || app.women);
    const others = done.filter((e) => !(forceDis && e === dis) && !(e.isDismount && e !== dis)).sort((a, b) => val(b) - val(a));
    const n = rs.counted - (forceDis ? 1 : 0);
    const counted = others.slice(0, Math.max(0, n));
    if (forceDis) counted.push(dis);
    dParts.counted = counted;
    dParts.difficulty = round1(counted.reduce((s, e) => s + val(e), 0));
    const groupCount = app.groups.filter((g) => opts.groups?.[g]).length;
    dParts.groups = round1(groupCount * rs.groupValue);
    // 男子（あん馬・つり輪・平行棒・鉄棒）：終末技グループ＝終末技の難度価値（上限 0.5）
    if (dis && app.dismountGroup) dParts.dismountGroup = Math.min(rs.dismountCap, val(dis));
    dParts.connection = opts.connection || 0;
    if (opts.stick && dis && dis.end <= uptoTime) dParts.stick = DEDUCTION_TABLE.stickBonus;
    D = round1(dParts.difficulty + dParts.groups + dParts.dismountGroup + dParts.connection + dParts.stick);
  }
  const ND = opts.neutral || 0;
  const total = round1(Math.max(0, D + E - ND));
  return { D, E, ND, total, eDed: round1(eDed), dParts, eItems };
}

export const LANDMARK_INDEX = LM;
