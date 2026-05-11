import { useEffect, useRef } from "react";

// Live waveform overlay shown while voice recording. Tries the mic via
// WebAudio; falls back to a synthetic sine sweep if mic access is
// denied or unavailable. Pure presentation — recording is owned by the
// voice controller, not this component.
export function Waveform({ active }: { active: boolean }) {
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
    let data: Uint8Array<ArrayBuffer> | null = null;

    const drawFrom = (samples: Uint8Array | null, phase: number) => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      const drawLine = (alpha: number, amp: number, freq: number, off: number) => {
        ctx.lineWidth = 2;
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.beginPath();
        const points = 220;
        for (let i = 0; i < points; i++) {
          const t = i / (points - 1);
          const x = t * w;
          let y: number;
          if (samples && samples.length) {
            const idx = Math.floor((i / points) * samples.length);
            const v = samples[idx] / 128 - 1;
            y = h / 2 + v * (h / 2) * amp;
          } else {
            y = h / 2 + Math.sin(t * Math.PI * freq + phase + off) * (h * 0.18) * amp;
          }
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };

      drawLine(0.85, 1, 4, 0);
      drawLine(0.4, 0.75, 6, Math.PI / 3);
    };

    let phase = 0;
    const loop = () => {
      if (analyser && data) {
        analyser.getByteTimeDomainData(data);
        drawFrom(data, 0);
      } else {
        drawFrom(null, phase);
        phase += 0.08;
      }
      raf = requestAnimationFrame(loop);
    };

    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        stream = s;
        audioCtx = new AudioContext();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.75;
        data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        audioCtx.createMediaStreamSource(s).connect(analyser);
      })
      .catch(() => {
        // fall through to synthetic loop
      });

    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (audioCtx) audioCtx.close().catch(() => {});
    };
  }, [active]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="waveform-canvas" aria-hidden="true" />;
}
