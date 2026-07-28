// Aether Flow — an animated particle-constellation backdrop plus an optional
// hero content block.
//
// Two exports, deliberately split so the effect is reusable on its own:
//   <ParticleField />     just the canvas; absolutely fills its parent.
//   <AetherFlowHero />    full-bleed section = ParticleField + centred content.
//                         Pass `children` to render your own content (the
//                         LoginPage does this); pass nothing and it renders the
//                         default eyebrow/title/subtitle/CTA copy.
//
// The canvas paints its own opaque background, so this section always reads as
// dark regardless of the active app theme — anything layered on top must be
// styled for a dark surface.
//
// Notes on the implementation:
//   * All particle maths runs in CSS pixels; the DPR scale lives in the canvas
//     transform, so the effect stays crisp on retina without doubling the
//     particle count.
//   * Particle count is density-derived but hard-capped — link drawing is
//     O(n²), and an uncapped count on a 4K display is a frame-rate cliff.
//   * `prefers-reduced-motion` paints a single static frame and never starts
//     the rAF loop or the pointer listeners.
//   * The loop is suspended while the tab is hidden — a login screen left open
//     shouldn't burn a core.

import { useEffect, useRef, type ReactNode } from 'react';
import { motion, type Variants } from 'framer-motion';
import { ArrowRight, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

const TAU = Math.PI * 2;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

export interface ParticleFieldProps {
  className?: string;
  /** Opaque backdrop painted under the particles each frame. */
  background?: string;
  /** Particle fill as a bare `R, G, B` triple — alpha is applied per-draw. */
  particleRgb?: string;
  /** Link stroke as a bare `R, G, B` triple. */
  lineRgb?: string;
  /** Stroke used for links near the pointer, as a bare `R, G, B` triple. */
  highlightRgb?: string;
  /** CSS px² of canvas per particle. Higher = sparser. */
  density?: number;
  /** Upper bound on particle count, whatever the density works out to. */
  maxParticles?: number;
  /** Max CSS px between two particles for a link to be drawn. */
  connectDistance?: number;
  /** Radius in CSS px within which the pointer pushes particles away. */
  mouseRadius?: number;
}

export function ParticleField({
  className,
  background = '#05060f',
  particleRgb = '150, 140, 255',
  lineRgb = '129, 140, 248',
  highlightRgb = '255, 255, 255',
  density = 11000,
  maxParticles = 180,
  connectDistance = 140,
  mouseRadius = 180,
}: ParticleFieldProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let frameId: number | null = null;
    const pointer: { x: number | null; y: number | null } = { x: null, y: null };

    function seed(): void {
      const target = Math.min(maxParticles, Math.round((width * height) / density));
      particles = Array.from({ length: Math.max(target, 0) }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: Math.random() * 0.4 - 0.2,
        vy: Math.random() * 0.4 - 0.2,
        r: Math.random() * 2 + 1,
      }));
    }

    function draw(): void {
      if (!ctx) return;
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);

      // Links first so the dots sit on top of the web.
      ctx.lineWidth = 1;
      const maxD2 = connectDistance * connectDistance;
      for (let a = 0; a < particles.length; a++) {
        const pa = particles[a];
        // A link counts as "near the pointer" when either endpoint is inside
        // the pointer radius — that's what makes the web brighten under the
        // cursor rather than only the dots.
        const aNear =
          pointer.x !== null &&
          pointer.y !== null &&
          Math.hypot(pa.x - pointer.x, pa.y - pointer.y) < mouseRadius;

        for (let b = a + 1; b < particles.length; b++) {
          const pb = particles[b];
          const dx = pa.x - pb.x;
          const dy = pa.y - pb.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > maxD2) continue;

          const alpha = 1 - Math.sqrt(d2) / connectDistance;
          const bNear =
            pointer.x !== null &&
            pointer.y !== null &&
            Math.hypot(pb.x - pointer.x, pb.y - pointer.y) < mouseRadius;

          ctx.strokeStyle = `rgba(${aNear || bNear ? highlightRgb : lineRgb}, ${alpha * 0.55})`;
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
      }

      ctx.fillStyle = `rgba(${particleRgb}, 0.8)`;
      for (const p of particles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, TAU, false);
        ctx.fill();
      }
    }

    function step(): void {
      for (const p of particles) {
        if (p.x <= 0 || p.x >= width) p.vx = -p.vx;
        if (p.y <= 0 || p.y >= height) p.vy = -p.vy;

        if (pointer.x !== null && pointer.y !== null) {
          const dx = pointer.x - p.x;
          const dy = pointer.y - p.y;
          const d = Math.hypot(dx, dy);
          if (d > 0 && d < mouseRadius + p.r) {
            const force = (mouseRadius - d) / mouseRadius;
            p.x -= (dx / d) * force * 5;
            p.y -= (dy / d) * force * 5;
          }
        }

        p.x += p.vx;
        p.y += p.vy;
        // The pointer shove can overshoot the bounds, and a direction flip
        // alone won't recover a particle that's already outside — clamp.
        p.x = Math.min(width, Math.max(0, p.x));
        p.y = Math.min(height, Math.max(0, p.y));
      }
    }

    function animate(): void {
      step();
      draw();
      frameId = requestAnimationFrame(animate);
    }

    function start(): void {
      if (reduceMotion || frameId !== null) return;
      frameId = requestAnimationFrame(animate);
    }

    function stop(): void {
      if (frameId === null) return;
      cancelAnimationFrame(frameId);
      frameId = null;
    }

    function resize(): void {
      if (!canvas || !ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      // Repaint immediately so a resize (or the reduced-motion path, which
      // never enters the rAF loop) never leaves a blank canvas on screen.
      draw();
    }

    function handlePointerMove(event: PointerEvent): void {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
    }

    function handlePointerLeave(): void {
      pointer.x = null;
      pointer.y = null;
    }

    function handleVisibility(): void {
      if (document.hidden) stop();
      else start();
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    if (!reduceMotion) {
      // Listening on window (not the canvas) keeps the canvas itself
      // pointer-events-none, so overlaid content stays fully interactive.
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerout', handlePointerLeave);
      document.addEventListener('visibilitychange', handleVisibility);
      start();
    }

    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerout', handlePointerLeave);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [
    background,
    particleRgb,
    lineRgb,
    highlightRgb,
    density,
    maxParticles,
    connectDistance,
    mouseRadius,
  ]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-0 h-full w-full', className)}
    />
  );
}

/**
 * Staggered fade-up entrance. Pass the index as framer-motion's `custom` so
 * siblings cascade: `<motion.div custom={2} variants={fadeUpVariants} … />`.
 */
export const fadeUpVariants: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: i * 0.15 + 0.2,
      duration: 0.8,
      ease: 'easeInOut',
    },
  }),
};

export interface AetherFlowHeroProps extends ParticleFieldProps {
  /** Small pill above the title. Ignored when `children` is given. */
  eyebrow?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  ctaLabel?: ReactNode;
  onCtaClick?: () => void;
  /** Replaces the whole default copy block. */
  children?: ReactNode;
  /** Classes for the section wrapper. */
  sectionClassName?: string;
  /** Classes for the content layer that sits above the canvas. */
  contentClassName?: string;
}

export default function AetherFlowHero({
  eyebrow = 'Dynamic Rendering Engine',
  title = 'Aether Flow',
  subtitle = 'An intelligent, adaptive framework for creating fluid digital experiences that feel alive and respond to user interaction in real-time.',
  ctaLabel = 'Explore the Engine',
  onCtaClick,
  children,
  sectionClassName,
  contentClassName,
  className,
  ...fieldProps
}: AetherFlowHeroProps): JSX.Element {
  return (
    <div
      className={cn(
        // min-h (not h) so taller content scrolls instead of being clipped.
        'relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden',
        sectionClassName,
      )}
    >
      <ParticleField className={className} {...fieldProps} />

      <div className={cn('relative z-10 w-full p-6 text-center', contentClassName)}>
        {children ?? (
          <>
            <motion.div
              custom={0}
              variants={fadeUpVariants}
              initial="hidden"
              animate="visible"
              className="mb-6 inline-flex items-center gap-2 rounded-full border border-purple-500/20 bg-purple-500/10 px-4 py-1.5 backdrop-blur-sm"
            >
              <Zap className="h-4 w-4 text-purple-400" />
              <span className="text-sm font-medium text-gray-200">{eyebrow}</span>
            </motion.div>

            <motion.h1
              custom={1}
              variants={fadeUpVariants}
              initial="hidden"
              animate="visible"
              className="mb-6 bg-gradient-to-b from-white to-gray-400 bg-clip-text text-5xl font-bold tracking-tighter text-transparent md:text-8xl"
            >
              {title}
            </motion.h1>

            <motion.p
              custom={2}
              variants={fadeUpVariants}
              initial="hidden"
              animate="visible"
              className="mx-auto mb-10 max-w-2xl text-lg text-gray-400"
            >
              {subtitle}
            </motion.p>

            <motion.div custom={3} variants={fadeUpVariants} initial="hidden" animate="visible">
              <button
                type="button"
                onClick={onCtaClick}
                className="mx-auto flex items-center gap-2 rounded-lg bg-white px-8 py-4 font-semibold text-black shadow-lg transition-colors duration-300 hover:bg-gray-200"
              >
                {ctaLabel}
                <ArrowRight className="h-5 w-5" />
              </button>
            </motion.div>
          </>
        )}
      </div>
    </div>
  );
}
