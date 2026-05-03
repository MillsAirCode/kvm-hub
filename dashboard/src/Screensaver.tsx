import { useEffect, useRef, useState } from "react";

/**
 * Idle screensaver — neural-net simulation overlay that fades in after no
 * interaction for IDLE_MS. Wakes on any keydown / mousemove / click.
 *
 * Pure procedural canvas, no external assets. Layered ASCII neurons fire
 * forward through the network in waves, edges dim and brighten as activations
 * propagate. Thematically appropriate for an AI agent ops console at idle.
 */

const IDLE_MS = 90_000;
const FADE_IN_MS = 800;

const LAYERS = 5;          // input, 3 hidden, output
const NEURONS_PER = [12, 16, 20, 16, 8];
const NEURON_SPACING_X = 220;   // between layers (px)
const ACTIVATION_DECAY = 0.92;  // per frame (~16ms)
const FIRE_TRAVEL_FRAMES = 12;  // frames for a wave to cross one layer
const NEURON_GLYPH = "○";
const NEURON_FIRE_GLYPH = "●";

interface Neuron {
  x: number; // canvas-space px
  y: number;
  layer: number;
  activation: number; // 0-1
}

export default function Screensaver() {
  const [armed, setArmed] = useState(false);
  const [opacity, setOpacity] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const idleTimerRef = useRef<number | null>(null);
  const fadeStartRef = useRef<number>(0);

  // Empty deps — activity tracking runs once on mount. Previously this had
  // [armed] which caused a feedback loop: timer fires → setArmed(true) →
  // effect re-runs → wake() called → setArmed(false) → screensaver never arms.
  // The activity tracker mutates `armed` state but doesn't depend on it.
  useEffect(() => {
    const wake = () => {
      setArmed((prev) => (prev ? false : prev));
      setOpacity(0);
      if (idleTimerRef.current != null) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => {
        fadeStartRef.current = performance.now();
        setArmed(true);
      }, IDLE_MS);
    };
    wake();
    const events: (keyof WindowEventMap)[] = [
      "mousemove", "mousedown", "keydown", "touchstart",
    ];
    events.forEach((e) => window.addEventListener(e, wake, { passive: true }));
    return () => {
      events.forEach((e) => window.removeEventListener(e, wake));
      if (idleTimerRef.current != null) window.clearTimeout(idleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!armed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let raf = 0;
    let neurons: Neuron[][] = []; // by layer
    let frame = 0;
    // Pending firings: (toLayer, framesUntilArrive, sourceIdx)
    let pending: { layer: number; framesLeft: number; idx: number }[] = [];

    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      // Center the network horizontally; vertical layout based on layer count
      const totalWidth = (LAYERS - 1) * NEURON_SPACING_X;
      const x0 = (w - totalWidth) / 2;
      neurons = [];
      for (let li = 0; li < LAYERS; li++) {
        const count = NEURONS_PER[li];
        const verticalSpan = h * 0.7;
        const yStart = (h - verticalSpan) / 2;
        const layerArr: Neuron[] = [];
        for (let ni = 0; ni < count; ni++) {
          layerArr.push({
            x: x0 + li * NEURON_SPACING_X,
            y: yStart + (count <= 1 ? verticalSpan / 2 : (ni / (count - 1)) * verticalSpan),
            layer: li,
            activation: 0,
          });
        }
        neurons.push(layerArr);
      }
      ctx.font = "bold 18px JetBrains Mono, ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = () => {
      const elapsed = performance.now() - fadeStartRef.current;
      const fade = Math.min(1, elapsed / FADE_IN_MS);
      setOpacity(fade);

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.fillStyle = "rgba(0, 0, 0, 0.20)"; // soft trail wash
      ctx.fillRect(0, 0, w, h);

      // Decay all activations
      for (const layer of neurons) {
        for (const n of layer) n.activation *= ACTIVATION_DECAY;
      }

      // Trigger new input firings on a Poisson-ish cadence
      if (frame % 18 === 0 || (frame > 0 && Math.random() < 0.015)) {
        const inputCount = neurons[0].length;
        // Fire 1-3 random input neurons
        const k = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < k; i++) {
          const idx = Math.floor(Math.random() * inputCount);
          neurons[0][idx].activation = 1.0;
          // Schedule propagation to layer 1
          pending.push({ layer: 1, framesLeft: FIRE_TRAVEL_FRAMES, idx });
        }
      }

      // Process pending firings
      const stillPending: typeof pending = [];
      for (const p of pending) {
        p.framesLeft -= 1;
        if (p.framesLeft <= 0) {
          // Arrive at p.layer — pick which neurons in that layer light up.
          // Use a deterministic-ish pattern: each source neuron projects to
          // a few neurons in the next layer based on its index.
          const targetLayer = neurons[p.layer];
          const fanIn = 3;
          for (let f = 0; f < fanIn; f++) {
            const targetIdx =
              (p.idx * 2 + f * 5 + Math.floor(Math.random() * 3)) % targetLayer.length;
            const strength = 0.55 + Math.random() * 0.4;
            targetLayer[targetIdx].activation = Math.max(
              targetLayer[targetIdx].activation,
              strength,
            );
            // Cascade to next layer
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

      // Draw edges (dim, faint dotted lines from each neuron in layer L to
      // each neuron in layer L+1). Brighten edges whose source is firing.
      for (let li = 0; li < LAYERS - 1; li++) {
        const src = neurons[li];
        const dst = neurons[li + 1];
        for (const a of src) {
          for (const b of dst) {
            const a2 = a.activation;
            // Strength of edge appearance based on source activation
            if (a2 < 0.05) {
              ctx.strokeStyle = "rgba(20, 80, 60, 0.18)";
            } else {
              const alpha = 0.18 + a2 * 0.55;
              ctx.strokeStyle = `rgba(110, 231, 183, ${alpha})`;
            }
            ctx.lineWidth = a2 > 0.4 ? 1.2 : 0.6;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Draw neurons on top of edges
      for (const layer of neurons) {
        for (const n of layer) {
          const a = n.activation;
          if (a > 0.55) {
            ctx.fillStyle = "#a7f3d0";
            ctx.shadowColor = "#34d399";
            ctx.shadowBlur = 14;
            ctx.fillText(NEURON_FIRE_GLYPH, n.x, n.y);
            ctx.shadowBlur = 0;
          } else if (a > 0.15) {
            const t = (a - 0.15) / 0.4;
            const r = Math.round(52 + t * (110 - 52));
            const g = Math.round(211 + t * (231 - 211));
            const b = Math.round(153 + t * (183 - 153));
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.shadowColor = "#34d399";
            ctx.shadowBlur = 6;
            ctx.fillText(NEURON_GLYPH, n.x, n.y);
            ctx.shadowBlur = 0;
          } else {
            ctx.fillStyle = "rgba(16, 80, 60, 0.55)";
            ctx.fillText(NEURON_GLYPH, n.x, n.y);
          }
        }
      }

      frame += 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [armed]);

  if (!armed) return null;

  return (
    <div
      className="fixed inset-0 z-[90] bg-black"
      style={{
        opacity,
        transition: `opacity ${FADE_IN_MS}ms ease-out`,
      }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ display: "block" }}
      />
      <div className="absolute inset-0 flex items-end justify-center pb-8 pointer-events-none">
        <div className="font-mono text-accent-glow phosphor text-xs sm:text-sm tracking-widest text-center">
          <div className="opacity-60 mb-1">— idle · neural net simulating —</div>
          <div className="opacity-40">press any key to resume</div>
        </div>
      </div>
    </div>
  );
}
