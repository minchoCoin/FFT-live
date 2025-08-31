// ====== 전역 ======
let audioCtx = null;
let analyser = null;
let mediaStream = null;
let sourceNode = null;
let rafId = null;

let freqData;      // Float32Array(dB, length = fftSize/2)
let timeData;      // Uint8Array time-domain
let binFreqs = []; // 각 bin 중심주파수(Hz)

let melFilters = null; // Float32Array[] (밴드 x bin)
let melBandCount = 64;
let melDbRange = 80;   // dB dynamic range for mel
const eps = 1e-10;

const els = {
  deviceSelect: document.getElementById('deviceSelect'),
  fftSize:      document.getElementById('fftSize'),
  smoothing:    document.getElementById('smoothing'),
  scale:        document.getElementById('scale'),
  melBands:     document.getElementById('melBands'),
  melRange:     document.getElementById('melRange'),
  startBtn:     document.getElementById('startBtn'),
  stopBtn:      document.getElementById('stopBtn'),
  sr:           document.getElementById('sr'),
  nyq:          document.getElementById('nyq'),
  fftStat:      document.getElementById('fftStat'),
  smoothStat:   document.getElementById('smoothStat'),
  scaleStat:    document.getElementById('scaleStat'),
  melStat:      document.getElementById('melStat'),
  canvasWrap:   document.getElementById('canvasWrap'),
  canvas:       document.getElementById('spectrum'),
  tooltip:      document.getElementById('tooltip'),
  melWrap:      document.getElementById('melWrap'),
  melCanvas:    document.getElementById('melCanvas'),
  specgramWrap:  document.getElementById('specgramWrap'),
  specgramCanvas:document.getElementById('specgramCanvas'),
};

const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
const specCtx = els.canvas.getContext('2d');
const melCtx  = els.melCanvas.getContext('2d');
const spgCtx = els.specgramCanvas.getContext('2d'); // raw spectrogram용
function setCanvasSize() {
  // Spectrum canvas
  const w1 = els.canvasWrap.clientWidth;
  const h1 = els.canvasWrap.clientHeight;
  els.canvas.width  = Math.floor(w1 * dpr);
  els.canvas.height = Math.floor(h1 * dpr);
  els.canvas.style.width  = w1 + 'px';
  els.canvas.style.height = h1 + 'px';
  specCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Raw spectrogram canvas
  const w3 = els.specgramWrap.clientWidth;
  const h3 = els.specgramWrap.clientHeight;
  els.specgramCanvas.width  = Math.floor(w3 * dpr);
  els.specgramCanvas.height = Math.floor(h3 * dpr);
  els.specgramCanvas.style.width  = w3 + 'px';
  els.specgramCanvas.style.height = h3 + 'px';
  spgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Mel canvas
  const w2 = els.melWrap.clientWidth;
  const h2 = els.melWrap.clientHeight;
  els.melCanvas.width  = Math.floor(w2 * dpr);
  els.melCanvas.height = Math.floor(h2 * dpr);
  els.melCanvas.style.width  = w2 + 'px';
  els.melCanvas.style.height = h2 + 'px';
  melCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ====== 스펙트럼 그리기 유틸 ======
function linToY(db, minDb, maxDb, height) {
  const t = (db - minDb) / (maxDb - minDb);
  return (1 - t) * height;
}

function mapFreqToX(freq, minF, maxF, width, mode) {
  if (mode === 'linear') {
    return clamp((freq / maxF) * width, 0, width);
  } else {
    const f = clamp(freq, minF, maxF);
    const t = (Math.log10(f) - Math.log10(minF)) / (Math.log10(maxF) - Math.log10(minF));
    return t * width;
  }
}

function xToFreq(x, minF, maxF, width, mode) {
  const t = clamp(x / width, 0, 1);
  if (mode === 'linear') return t * maxF;
  return Math.pow(10, Math.log10(minF) + t * (Math.log10(maxF) - Math.log10(minF)));
}

function freqToBin(freq, sampleRate, fftSize) {
  return Math.round(freq * fftSize / sampleRate);
}

function renderRawSpectrogram() {
  if (!analyser) return;

  analyser.getFloatFrequencyData(freqData);

  // ★ 유한값(max) 계산 (NaN/-Infinity 방지)
  const nbin = freqData.length;
  let topDb = -Infinity;
  for (let i = 0; i < nbin; i++) {
    const v = freqData[i];
    if (Number.isFinite(v) && v > topDb) topDb = v;
  }
  if (!Number.isFinite(topDb)) topDb = -30;  // 합리적 기본값

  const minDb = topDb - melDbRange; // 기존처럼 다이내믹레인지 재사용
  const maxDb = topDb;

  const w = els.specgramCanvas.width / dpr;
  const h = els.specgramCanvas.height / dpr;

  // 기존 이미지 한 픽셀 왼쪽으로 이동
  const img = spgCtx.getImageData(1 * dpr, 0, (w - 1) * dpr, h * dpr);
  spgCtx.putImageData(img, 0, 0);

  // 새 컬럼
  const colX = (w - 1) * dpr;
  const colH = h * dpr;
  const colImg = spgCtx.createImageData(1, colH);

  const mode = els.scale.value;
  const sr = audioCtx.sampleRate;
  const nyq = sr / 2;

  for (let row = 0; row < colH; row++) {
    let binIdx;
    if (mode === 'linear') {
      const frac = 1 - row / colH;
      binIdx = Math.round(frac * (nbin - 1));
    } else {
      const frac = 1 - row / colH;
      const f = Math.pow(10, Math.log10(20) + frac * (Math.log10(nyq) - Math.log10(20)));
      binIdx = clamp(Math.round(f * analyser.fftSize / sr), 0, nbin - 1);
    }

    // dB 정규화 → 0..1
    let db = freqData[binIdx];
    if (!Number.isFinite(db)) db = minDb; // 방어
    const v = (db - minDb) / Math.max(maxDb - minDb, 1e-6);

    const [R, G, B] = infernoColor(v);
    const off = row * 4;
    colImg.data[off]     = R;
    colImg.data[off + 1] = G;
    colImg.data[off + 2] = B;
    colImg.data[off + 3] = 255;
  }

  spgCtx.putImageData(colImg, colX, 0);
}

function drawGrid(ctx, width, height, minF, maxF, mode, minDb, maxDb) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#1f2a38';

  const dbTicks = [-90, -60, -30];
  ctx.beginPath();
  dbTicks.forEach(db => {
    const y = linToY(db, minDb, maxDb, height);
    ctx.moveTo(0, y + .5);
    ctx.lineTo(width, y + .5);
  });
  ctx.stroke();

  const freqTicks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  ctx.beginPath();
  freqTicks.forEach(f => {
    if (f > maxF) return;
    const x = Math.round(mapFreqToX(f, minF, maxF, width, mode)) + .5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  });
  ctx.stroke();

  ctx.fillStyle = '#9fb0c3';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('dB', 6, 6);

  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText('Hz', width - 6, height - 6);

  ctx.fillStyle = '#7f93aa'; ctx.textAlign = 'left';
  dbTicks.forEach(db => {
    const y = linToY(db, minDb, maxDb, height);
    ctx.fillText(`${db} dB`, 6, clamp(y + 2, 2, height - 14));
  });

  ctx.textAlign = 'center';
  freqTicks.forEach(f => {
    if (f > maxF) return;
    const x = mapFreqToX(f, minF, maxF, width, mode);
    const label = f >= 1000 ? `${(f/1000)}k` : `${f}`;
    ctx.fillText(label, clamp(x, 12, width - 12), height - 18);
  });

  ctx.restore();
}

function updateStats() {
  const sr = audioCtx ? Math.round(audioCtx.sampleRate) : 0;
  const nyq = sr ? Math.round(sr / 2) : 0;
  els.sr.textContent = `Sample Rate: ${sr || '-'} Hz`;
  els.nyq.textContent = `Nyquist: ${nyq || '-'} Hz`;
  els.fftStat.textContent = `FFT: ${analyser ? analyser.fftSize : els.fftSize.value}`;
  els.smoothStat.textContent = `Smoothing: ${Number(els.smoothing.value).toFixed(2)}`;
  els.scaleStat.textContent = `Scale: ${els.scale.value === 'log' ? 'Log' : 'Linear'}`;
  els.melStat.textContent = `Mel: ${melBandCount} bands`;
}

function rebuildBinFreqs() {
  if (!audioCtx || !analyser) return;
  const n = analyser.frequencyBinCount;
  const sr = audioCtx.sampleRate;
  binFreqs = new Array(n);
  for (let i = 0; i < n; i++) binFreqs[i] = i * sr / analyser.fftSize;
}

// ====== Mel 필터뱅크 ======
function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700); }
function melToHz(mel) { return 700 * (Math.pow(10, mel / 2595) - 1); }

function buildMelFilterBank(sampleRate, fftSize, nMels, fMin = 20, fMax = sampleRate / 2) {
  const nFftBins = Math.floor(fftSize / 2);
  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);
  const melPoints = new Array(nMels + 2);
  for (let i = 0; i < melPoints.length; i++) {
    const mel = melMin + (melMax - melMin) * (i / (nMels + 1));
    melPoints[i] = melToHz(mel);
  }
  const binPoints = melPoints.map(f => Math.floor((fftSize + 1) * f / sampleRate));

  const filters = [];
  for (let m = 1; m <= nMels; m++) {
    const fbank = new Float32Array(nFftBins);
    const left = binPoints[m - 1];
    const center = binPoints[m];
    const right = binPoints[m + 1];

    for (let k = left; k < center; k++) {
      if (k >= 0 && k < nFftBins) {
        fbank[k] = (k - left) / Math.max(center - left, 1);
      }
    }
    for (let k = center; k < right; k++) {
      if (k >= 0 && k < nFftBins) {
        fbank[k] = (right - k) / Math.max(right - center, 1);
      }
    }
    filters.push(fbank);
  }
  return filters;
}

// ====== 스펙트럼 & Mel 렌더 ======
function renderSpectrum() {
  if (!analyser) return;

  const width  = els.canvas.width / dpr;
  const height = els.canvas.height / dpr;

  specCtx.clearRect(0, 0, width, height);
  specCtx.fillStyle = '#0a111a';
  specCtx.fillRect(0, 0, width, height);

  const minDb = analyser.minDecibels; // -100
  const maxDb = analyser.maxDecibels; // -30
  const mode = els.scale.value;
  const minF = 20;
  const maxF = Math.min((audioCtx.sampleRate || 48000) / 2, 22050);

  drawGrid(specCtx, width, height, minF, maxF, mode, minDb, maxDb);

  analyser.getFloatFrequencyData(freqData);

  specCtx.save();
  specCtx.lineWidth = 1.5;
  specCtx.strokeStyle = '#49a3ff';
  specCtx.beginPath();

  const n = freqData.length;
  let moved = false;
  for (let i = 1; i < n; i++) {
    const f = binFreqs[i];
    if (f < minF) continue;
    const x = mapFreqToX(f, minF, maxF, width, mode);
    const db = clamp(freqData[i], minDb, maxDb);
    const y  = linToY(db, minDb, maxDb, height);
    if (!moved) { specCtx.moveTo(x, y); moved = true; } else { specCtx.lineTo(x, y); }
  }
  specCtx.stroke();
  specCtx.lineTo(width, height);
  specCtx.lineTo(0, height);
  specCtx.closePath();
  specCtx.fillStyle = 'rgba(73,163,255,0.07)';
  specCtx.fill();
  specCtx.restore();
}

function renderMel() {
  if (!analyser || !melFilters) return;

  // 1) Analyser dB -> 선형 magnitude -> power
  analyser.getFloatFrequencyData(freqData);
  const n = freqData.length;
  // power spectrum
  const power = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const mag = Math.pow(10, freqData[i] / 20); // dB -> magnitude
    power[i] = mag * mag;                        // power
  }

  // 2) Mel 필터 적용 (행렬-벡터 곱)
  const mels = new Float32Array(melFilters.length);
  for (let m = 0; m < melFilters.length; m++) {
    const fbank = melFilters[m];
    let sum = 0;
    for (let k = 0; k < n; k++) {
      sum += fbank[k] * power[k];
    }
    mels[m] = 10 * Math.log10(Math.max(sum, eps)); // mel power -> dB
  }

  // 3) dB 정규화 (top 최대값 기준, 아래쪽 클램프)
  const maxDb = Math.max(...mels);
  const minDb = maxDb - melDbRange;

  // 4) 오른쪽 1px 새 컬럼 그리기 — 이미지 좌로 스크롤
  const w = els.melCanvas.width / dpr;
  const h = els.melCanvas.height / dpr;

  // 기존 이미지 한 픽셀 왼쪽으로 이동
  const img = melCtx.getImageData(1 * dpr, 0, (w - 1) * dpr, h * dpr);
  melCtx.putImageData(img, 0, 0);

  // 새 컬럼(마지막 열) 그리기
  const colX = (w - 1) * dpr;
  const colH = h * dpr;
  const colImg = melCtx.createImageData(1, colH);

  for (let row = 0; row < colH; row++) {
  const melIdx = Math.floor((1 - row / colH) * (mels.length - 1));
  const v = clamp((mels[melIdx] - minDb) / Math.max(melDbRange, 1), 0, 1);

  // ★ 변경: 그레이스케일 → Turbo 컬러맵
  const [R, G, B] = infernoColor(v);

  const offset = row * 4;
  colImg.data[offset    ] = R;
  colImg.data[offset + 1] = G;
  colImg.data[offset + 2] = B;
  colImg.data[offset + 3] = 255;
}
  melCtx.putImageData(colImg, colX, 0);
}
function infernoColor(v) {
  v = Math.min(1, Math.max(0, v));
  const c = [
    [0, 0, 4], [31, 12, 72], [85, 15, 109],
    [136, 34, 106], [186, 54, 85],
    [227, 89, 51], [249, 140, 10],
    [252, 195, 40], [252, 255, 164]
  ];
  const p = v * (c.length - 1);
  const i = Math.floor(p);
  const t = p - i;
  if (i >= c.length - 1) return c[c.length - 1];
  const [r1, g1, b1] = c[i];
  const [r2, g2, b2] = c[i + 1];
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return [r, g, b];
}

// ====== 툴팁 ======
function setupTooltip() {
  let hovering = false;
  els.canvasWrap.addEventListener('mousemove', (ev) => {
    if (!audioCtx || !analyser) return;
    const rect = els.canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left);
    const width  = els.canvas.width / dpr;

    const mode = els.scale.value;
    const minF = 20;
    const maxF = Math.min((audioCtx.sampleRate || 48000) / 2, 22050);

    const f = xToFreq(x, minF, maxF, width, mode);
    const bin = clamp(freqToBin(f, audioCtx.sampleRate, analyser.fftSize), 0, freqData.length - 1);
    const db = clamp(freqData ? freqData[bin] : -100, analyser ? analyser.minDecibels : -100, analyser ? analyser.maxDecibels : -30);

    const binFreq = binFreqs[bin];
    const fLabel = binFreq >= 1000 ? `${(binFreq/1000).toFixed(2)} kHz` : `${binFreq.toFixed(1)} Hz`;
    els.tooltip.textContent = `${fLabel} | ${db.toFixed(1)} dB`;

    els.tooltip.style.left = `${x}px`;
    els.tooltip.style.top  = `${ev.clientY - rect.top}px`;
    if (!hovering) { hovering = true; els.tooltip.style.opacity = 1; }
  });

  els.canvasWrap.addEventListener('mouseleave', () => {
    els.tooltip.style.opacity = 0;
  });
}

// ====== 장치 ======
async function populateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    const sel = els.deviceSelect;
    sel.innerHTML = '';
    inputs.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `마이크 ${i + 1}`;
      sel.appendChild(opt);
    });
  } catch (e) { console.error(e); }
}

// ====== 오디오 start/stop ======
async function start() {
  try {
    const constraints = {
      audio: {
        deviceId: els.deviceSelect.value ? { exact: els.deviceSelect.value } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    };
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    await populateDevices();

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = parseInt(els.fftSize.value, 10);
    analyser.smoothingTimeConstant = Number(els.smoothing.value);
    analyser.minDecibels = -100;
    analyser.maxDecibels = -30;

    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    // 필요 시 필터 삽입 지점
    // const hp = audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value = 50; hp.Q.value = .707;
    // sourceNode.connect(hp); hp.connect(analyser);
    sourceNode.connect(analyser);

    freqData = new Float32Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);

    rebuildBinFreqs();

    // Mel 필터 생성
    melBandCount = parseInt(els.melBands.value, 10);
    melDbRange   = parseInt(els.melRange.value, 10);
    melFilters   = buildMelFilterBank(audioCtx.sampleRate, analyser.fftSize, melBandCount);

    setCanvasSize();
    updateStats();

    cancelAnimationFrame(rafId);
    const loop = () => {
      renderSpectrum();
      renderMel();
      renderRawSpectrogram();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
  } catch (err) {
    console.error(err);
    alert('마이크 접근에 실패했습니다. 브라우저/권한/HTTPS(또는 localhost) 여부를 확인하세요.');
  }
}

function stop() {
  try {
    cancelAnimationFrame(rafId);
    rafId = null;

    if (sourceNode) { try { sourceNode.disconnect(); } catch(_){} }
    if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close();

    audioCtx = null; analyser = null; mediaStream = null; sourceNode = null;
    specCtx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    melCtx.clearRect(0, 0, els.melCanvas.width, els.melCanvas.height);

    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    updateStats();
  } catch(e) { console.error(e); }
}

// ====== 이벤트 ======
window.addEventListener('resize', setCanvasSize);
els.startBtn.addEventListener('click', start);
els.stopBtn.addEventListener('click', stop);

els.fftSize.addEventListener('change', () => {
  if (!analyser) return;
  analyser.fftSize = parseInt(els.fftSize.value, 10);
  freqData = new Float32Array(analyser.frequencyBinCount);
  timeData = new Uint8Array(analyser.fftSize);
  rebuildBinFreqs();
  // Mel 필터도 재생성
  melFilters = buildMelFilterBank(audioCtx.sampleRate, analyser.fftSize, melBandCount);
  updateStats();
});

els.smoothing.addEventListener('input', () => {
  if (!analyser) return;
  analyser.smoothingTimeConstant = Number(els.smoothing.value);
  updateStats();
});

els.scale.addEventListener('change', updateStats);

els.melBands.addEventListener('change', () => {
  melBandCount = parseInt(els.melBands.value, 10);
  if (audioCtx && analyser) {
    melFilters = buildMelFilterBank(audioCtx.sampleRate, analyser.fftSize, melBandCount);
  }
  updateStats();
});

els.melRange.addEventListener('change', () => {
  melDbRange = parseInt(els.melRange.value, 10);
});

setCanvasSize();
setupTooltip();
if (navigator.mediaDevices?.enumerateDevices) { populateDevices().catch(()=>{}); }
