import { useEffect, useRef } from "react";

// Siri-style grayscale waveform. Several translucent sine-wave layers
// are stacked over the pane: each layer reads a different frequency
// band from the analyser so highs/mids/lows independently drive their
// own ribbon. An edge envelope (sin·π·t) tapers the curves toward the
// left and right so the energy concentrates in the middle. A small
// canvas-level shadow blur gives the bands the soft glow Siri uses.
//
// `useMic = false` runs the same animation against a low-amplitude
// synthetic phase, so voice-mode-idle still reads as "alive."

interface Layer {
  freq: number;       // base spatial frequency (cycles across width)
  speed: number;      // phase advance per frame
  bin: number;        // 0..1 — which frequency-bin to sample for amplitude
  alpha: number;      // 0..1 — stroke alpha
  width: number;      // stroke width in px
  glow: number;       // shadow blur radius in px
  drift: number;      // per-frame frequency drift (small) for organic feel
}

const LAYERS: Layer[] = [
  { freq: 1.0, speed: 0.030, bin: 0.04, alpha: 0.95, width: 2.4, glow: 10, drift: 0.0008 },
  { freq: 1.6, speed: 0.045, bin: 0.10, alpha: 0.55, width: 2.0, glow: 8,  drift: 0.0012 },
  { freq: 2.3, speed: 0.060, bin: 0.20, alpha: 0.38, width: 1.6, glow: 6,  drift: 0.0014 },
  { freq: 3.2, speed: 0.080, bin: 0.35, alpha: 0.24, width: 1.3, glow: 4,  drift: 0.0018 },
];

// Min amplitude floor so the curves never collapse to a flat line.
const FLOOR = 0.28;
// Mic amplitude scaling.
const MIC_GAIN = 2.4;
// Synthetic-only amplitude (when not using mic).
const AMBIENT = 0.55;
// Fraction of pane height occupied at full amplitude.
const HEIGHT_SCALE = 0.48;

export function Waveform({
  active,
  useMic = false,
}: {
  active: boolean;
  useMic?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const sizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    sizeCanvas();
    const ro = new ResizeObserver(sizeCanvas);
    ro.observe(canvas);

    let raf = 0;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let freq: Uint8Array<ArrayBuffer> | null = null;

    // Per-layer smoothed amplitude (so silence doesn't snap the curves
    // to zero — they ease in/out).
    const amps = LAYERS.map(() => FLOOR);
    const phases = LAYERS.map(() => Math.random() * Math.PI * 2);

    const sampleAmp = (l: Layer): number => {
      if (!freq) return AMBIENT;
      // Average a small slice around `bin` for stability.
      const c = Math.floor(l.bin * freq.length);
      const span = Math.max(2, Math.floor(freq.length * 0.04));
      let sum = 0;
      let n = 0;
      for (let i = c - span; i <= c + span; i++) {
        if (i >= 0 && i < freq.length) {
          sum += freq[i];
          n++;
        }
      }
      const v = (sum / (n * 255)) * MIC_GAIN;
      return Math.min(1, v);
    };

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      if (analyser && freq) analyser.getByteFrequencyData(freq);

      // Slightly additive composition so overlapping bands brighten
      // rather than occlude each other — gives the Siri layered glow.
      ctx.globalCompositeOperation = "lighter";

      for (let li = 0; li < LAYERS.length; li++) {
        const l = LAYERS[li];
        const target = Math.max(FLOOR, sampleAmp(l));
        // Smoothing toward target — rises fast, decays slower.
        const k = target > amps[li] ? 0.35 : 0.08;
        amps[li] += (target - amps[li]) * k;
        phases[li] += l.speed;

        const amp = amps[li];
        const drift = Math.sin(phases[li] * 0.7) * l.drift * 8;
        const f = l.freq + drift;

        ctx.lineWidth = l.width;
        ctx.strokeStyle = `rgba(255,255,255,${l.alpha})`;
        ctx.shadowColor = `rgba(255,255,255,${l.alpha * 0.55})`;
        ctx.shadowBlur = l.glow;
        ctx.beginPath();

        const steps = 180;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = t * w;
          // Envelope: 0 at edges, 1 at center. Pulled to a soft cosine
          // for a rounder taper than a triangle.
          const envelope = 0.5 - 0.5 * Math.cos(Math.PI * 2 * t);
          // Layer the wave with a secondary harmonic so the curve isn't
          // a clean sine — it ripples like the Siri animation.
          const y =
            h / 2 +
            (Math.sin(2 * Math.PI * f * t + phases[li]) * 0.7 +
              Math.sin(2 * Math.PI * f * 1.7 * t - phases[li] * 0.4) * 0.3) *
              envelope *
              amp *
              (h * HEIGHT_SCALE);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Reset compositing for any other draws (defensive).
      ctx.globalCompositeOperation = "source-over";
      ctx.shadowBlur = 0;
    };

    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };

    if (useMic) {
      navigator.mediaDevices
        ?.getUserMedia({ audio: true })
        .then((s) => {
          stream = s;
          audioCtx = new AudioContext();
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.7;
          freq = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
          audioCtx.createMediaStreamSource(s).connect(analyser);
        })
        .catch(() => {
          // synthetic loop continues
        });
    }

    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (audioCtx) audioCtx.close().catch(() => {});
    };
  }, [active, useMic]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="waveform-canvas" aria-hidden="true" />;
}
