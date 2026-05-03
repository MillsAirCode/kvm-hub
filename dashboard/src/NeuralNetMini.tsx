import { useEffect, useRef } from "react";

/**
 * Compact neural-net canvas — used as the AgentDeck card header to replace
 * the pre-rendered MP4 loops. Same firing-cascade logic as the Screensaver
 * but parameterized by per-agent color and an active flag (firings only
 * happen while active=true). Idle agents show a quiet static net.
 */

interface Neuron {
  x: number;
  y: number;
  layer: number;
  activation: number;
}

const LAYERS = 4;
const NEURONS_PER = [4, 6, 6, 4];
const FIRE_TRAVEL_FRAMES = 8;
const ACTIVATION_DECAY = 0.92;

interface RGB {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export default function NeuralNetMini({
  color = "#34d399",
  glowColor,
  active = false,
}: {
  /** Bright/firing color (hex) */
  color?: string;
  /** Optional brighter glow color; defaults to lightened version of color */
  glowColor?: string;
  /** When true, neurons fire periodically. When false, the net is frozen quiet. */
  active?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rgb = hexToRgb(color);
    const glowRgb = glowColor ? hexToRgb(glowColor) : rgb;

    let raf = 0;
    let neurons: Neuron[][] = [];
    let frame = 0;
    let pending: { layer: number; framesLeft: number; idx: number }[] = [];

    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      neurons = [];
      const xMargin = 8;
      const yMargin = 6;
      for (let li = 0; li < LAYERS; li++) {
        const count = NEURONS_PER[li];
        const x = xMargin + (li / (LAYERS - 1)) * (w - 2 * xMargin);
        const layerArr: Neuron[] = [];
        for (let ni = 0; ni < count; ni++) {
          const y = count <= 1
            ? h / 2
            : yMargin + (ni / (count - 1)) * (h - 2 * yMargin);
          layerArr.push({ x, y, layer: li, activation: 0 });
        }
        neurons.push(layerArr);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      // Decay
      for (const layer of neurons) {
        for (const n of layer) n.activation *= ACTIVATION_DECAY;
      }

      // Periodic input firings — only when active
      if (active) {
        if (frame % 14 === 0 || (frame > 0 && Math.random() < 0.04)) {
          const inputCount = neurons[0].length;
          const k = 1 + Math.floor(Math.random() * 2);
          for (let i = 0; i < k; i++) {
            const idx = Math.floor(Math.random() * inputCount);
            neurons[0][idx].activation = 1.0;
            pending.push({ layer: 1, framesLeft: FIRE_TRAVEL_FRAMES, idx });
          }
        }
      }

      // Process pending firings
      const stillPending: typeof pending = [];
      for (const p of pending) {
        p.framesLeft -= 1;
        if (p.framesLeft <= 0) {
          const targetLayer = neurons[p.layer];
          const fanIn = 2;
          for (let f = 0; f < fanIn; f++) {
            const targetIdx =
              (p.idx * 2 + f * 3 + Math.floor(Math.random() * 2)) % targetLayer.length;
            const strength = 0.55 + Math.random() * 0.4;
            targetLayer[targetIdx].activation = Math.max(
              targetLayer[targetIdx].activation,
              strength,
            );
            if (p.layer < LAYERS - 1) {
              stillPending.push({
                layer: p.layer + 1,
                framesLeft: FIRE_TRAVEL_FRAMES,
                idx: targetIdx,
              });
            }
          }
        } else {
          stillPending.push(p);
        }
      }
      pending = stillPending;

      // Edges
      for (let li = 0; li < LAYERS - 1; li++) {
        const src = neurons[li];
        const dst = neurons[li + 1];
        for (const a of src) {
          for (const b of dst) {
            const a2 = a.activation;
            if (a2 < 0.05) {
              ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.10)`;
            } else {
              const alpha = 0.15 + a2 * 0.55;
              ctx.strokeStyle = `rgba(${glowRgb.r},${glowRgb.g},${glowRgb.b},${alpha})`;
            }
            ctx.lineWidth = a2 > 0.4 ? 1.0 : 0.5;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Neurons
      for (const layer of neurons) {
        for (const n of layer) {
          const a = n.activation;
          if (a > 0.55) {
            ctx.fillStyle = `rgb(${glowRgb.r},${glowRgb.g},${glowRgb.b})`;
            ctx.shadowColor = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.arc(n.x, n.y, 2.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
          } else if (a > 0.15) {
            const t = (a - 0.15) / 0.4;
            const cr = Math.round(rgb.r + t * (glowRgb.r - rgb.r));
            const cg = Math.round(rgb.g + t * (glowRgb.g - rgb.g));
            const cb = Math.round(rgb.b + t * (glowRgb.b - rgb.b));
            ctx.fillStyle = `rgba(${cr},${cg},${cb},0.85)`;
            ctx.beginPath();
            ctx.arc(n.x, n.y, 1.6, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.45)`;
            ctx.beginPath();
            ctx.arc(n.x, n.y, 1.4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      frame += 1;

      // When idle, stop the loop after activations + pending firings have
      // fully decayed/drained. This makes idle agents render exactly once
      // and stay completely still — no residual shimmer from the raf loop.
      if (!active) {
        const anyActivation = neurons.some((layer) => layer.some((n) => n.activation > 0.02));
        if (!anyActivation && pending.length === 0) {
          // Settled: draw one final static frame and exit the loop.
          return;
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [color, glowColor, active]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ display: "block" }}
    />
  );
}
