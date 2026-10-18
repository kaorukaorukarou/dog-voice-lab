/* Exploratory acoustic descriptors. This is NOT an emotion classifier.
 * Uniformly sample analysis frames over the entire file, not merely its beginning.
 * F0 is a coarse autocorrelation-based estimate, and may be undefined.
 */
'use strict';
function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function magnitudeSpectrum(frame) {
  const N = frame.length, re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = frame[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {const x = re[i]; re[i] = re[j]; re[j] = x; const y = im[i]; im[i] = im[j]; im[j] = y;}
  }
  for (let len = 2; len <= N; len <<= 1) {
    const phase = -2 * Math.PI / len, cw = Math.cos(phase), sw = Math.sin(phase);
    for (let i = 0; i < N; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const x = re[b] * wr - im[b] * wi;
        const y = re[b] * wi + im[b] * wr;
        re[b] = re[a] - x; im[b] = im[a] - y;
        re[a] += x; im[a] += y;
        const temp = wr * cw - wi * sw;
        wi = wr * sw + wi * cw;
        wr = temp;
      }
    }
  }
  const result = new Float64Array(N / 2 + 1);
  for (let k = 0; k < result.length; k++) result[k] = Math.hypot(re[k], im[k]);
  return result;
}
function coarsePitch(frame, sr) {
  const n = frame.length;
  let mean = 0, energy = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean /= n;
  for (let i = 0; i < n; i++) energy += (frame[i] - mean) ** 2;
  if (energy / n < 0.000025) return null;
  const minLag = Math.max(2, Math.floor(sr / 900));
  const maxLag = Math.min(n / 2 | 0, Math.ceil(sr / 80));
  let best = 0.65, winningLag = 0;
  const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let cross = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < n - lag; i++) {
      const a = frame[i] - mean, b = frame[i + lag] - mean;
      cross += a * b; e1 += a * a; e2 += b * b;
    }
    const score = cross / Math.sqrt(e1 * e2 + 1e-12);
    scores[lag] = score;
    if (score > best) {best = score; winningLag = lag;}
  }
  if (!winningLag) return null;
  // Use the earliest strong local maximum to reduce octave-down errors
  // when the autocorrelation has similarly strong harmonic peaks.
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (scores[lag] >= Math.max(0.74, best * 0.92) &&
        scores[lag] > scores[lag-1] && scores[lag] >= scores[lag+1]) return sr / lag;
  }
  return sr / winningLag;
}
function analyze(audio, sampleRate) {
  if (!audio.length || !sampleRate) throw new Error('有効な音声がありません');
  let sum = 0, peak = 0, zeroCrossings = 0;
  for (let i = 0; i < audio.length; i++) {
    const v = audio[i];
    sum += v * v;
    const a = Math.abs(v); if (a > peak) peak = a;
    if (i && (v >= 0) !== (audio[i - 1] >= 0)) zeroCrossings++;
  }
  const rms = Math.sqrt(sum / audio.length), frameSize = 2048;
  const frameCount = Math.max(0, Math.floor((audio.length - frameSize) / 1024) + 1);
  const target = Math.min(frameCount, 125);
  let centroidSum = 0, flatnessSum = 0, accepted = 0, attemptedPitch = 0;
  const f0s = [];
  for (let i = 0; i < target; i++) {
    const start = target === 1 ? 0 : Math.round(i * (audio.length - frameSize) / (target - 1));
    const frame = audio.subarray(start, start + frameSize);
    let frameEnergy = 0;
    for (let j = 0; j < frame.length; j++) frameEnergy += frame[j] * frame[j];
    if (Math.sqrt(frameEnergy / frame.length) < Math.max(0.006, rms * .12)) continue;
    const mag = magnitudeSpectrum(frame);
    let total = 0, weighted = 0, logSum = 0;
    for (let k = 1; k < mag.length; k++) {
      const m = mag[k];
      total += m;
      weighted += (k * sampleRate / frameSize) * m;
      logSum += Math.log(m + 1e-12);
    }
    if (total > 1e-12) {
      centroidSum += weighted / total;
      flatnessSum += Math.exp(logSum / (mag.length - 1)) / (total / (mag.length - 1));
      accepted++;
    }
    if (i % 3 === 0) {
      attemptedPitch++;
      const f0 = coarsePitch(frame, sampleRate);
      if (f0 !== null) f0s.push(f0);
    }
  }
  const round = (v, digits) => Number(v.toFixed(digits));
  return {
    duration_s: round(audio.length / sampleRate, 3),
    sample_rate_hz: sampleRate,
    rms: round(rms, 5), peak: round(peak, 5),
    zero_crossing_rate: round(zeroCrossings / audio.length, 5),
    spectral_centroid_hz: accepted ? round(centroidSum / accepted, 1) : null,
    spectral_flatness: accepted ? round(flatnessSum / accepted, 4) : null,
    f0_hz: f0s.length ? round(median(f0s), 1) : null,
    f0_valid_frames: f0s.length, f0_total_frames: attemptedPitch,
    analyzed_spectral_frames: target, accepted_spectral_frames: accepted
  };
}
self.onmessage = (evt) => {
  const {samples, sampleRate, requestId} = evt.data;
  try {
    self.postMessage({requestId, features: analyze(new Float32Array(samples), sampleRate)});
  } catch (err) {
    self.postMessage({requestId, error: err.message || String(err)});
  }
};
