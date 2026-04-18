import { useEffect, useRef } from "react";

interface AnimatedHourglassProps {
  size?: number;
  message?: string;
}

export default function AnimatedHourglass({ size = 180, message = "Processing your order..." }: AnimatedHourglassProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const timeRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = size;
    const h = size;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);

    const cx = w / 2;
    const cy = h / 2;

    const particles: { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number }[] = [];

    function spawnParticle() {
      const t = timeRef.current / 250;
      const phase = t % 1;
      if (phase > 0.42) return;
      const dropX = cx + (Math.random() - 0.5) * 3;
      const dropY = cy - 2;
      particles.push({
        x: dropX,
        y: dropY,
        vx: (Math.random() - 0.5) * 0.4,
        vy: 1.5 + Math.random() * 0.8,
        life: 0,
        maxLife: 18 + Math.random() * 12,
        size: 1.5 + Math.random() * 1.5,
      });
    }

    function drawHourglass(rotation: number, sandFraction: number) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation);

      const glassH = h * 0.38;
      const topW = w * 0.34;
      const neckW = w * 0.04;
      const bulgeX = w * 0.38;

      // Outer shadow / glow
      ctx.shadowColor = "rgba(60, 150, 255, 0.45)";
      ctx.shadowBlur = 18;

      // Glass shape using bezier curves
      const grad = ctx.createLinearGradient(-bulgeX, -glassH, bulgeX, glassH);
      grad.addColorStop(0, "rgba(30, 80, 170, 0.18)");
      grad.addColorStop(0.5, "rgba(80, 160, 255, 0.10)");
      grad.addColorStop(1, "rgba(30, 80, 170, 0.18)");

      ctx.beginPath();
      ctx.moveTo(-topW, -glassH);
      ctx.bezierCurveTo(-bulgeX, -glassH * 0.7, -neckW, -glassH * 0.15, -neckW, 0);
      ctx.bezierCurveTo(-neckW, glassH * 0.15, -bulgeX, glassH * 0.7, -topW, glassH);
      ctx.lineTo(topW, glassH);
      ctx.bezierCurveTo(bulgeX, glassH * 0.7, neckW, glassH * 0.15, neckW, 0);
      ctx.bezierCurveTo(neckW, -glassH * 0.15, bulgeX, -glassH * 0.7, topW, -glassH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Glass border
      const borderGrad = ctx.createLinearGradient(-bulgeX, 0, bulgeX, 0);
      borderGrad.addColorStop(0, "rgba(100, 180, 255, 0.7)");
      borderGrad.addColorStop(0.5, "rgba(180, 220, 255, 0.95)");
      borderGrad.addColorStop(1, "rgba(100, 180, 255, 0.7)");
      ctx.strokeStyle = borderGrad;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.shadowBlur = 0;

      // Top bulb sand
      const topSandH = glassH * 0.82 * (1 - sandFraction);
      if (topSandH > 2) {
        const topSandY = -glassH + topSandH;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(-topW, -glassH);
        ctx.bezierCurveTo(-bulgeX, -glassH * 0.7, -neckW, -glassH * 0.15, -neckW, 0);
        ctx.lineTo(neckW, 0);
        ctx.bezierCurveTo(neckW, -glassH * 0.15, bulgeX, -glassH * 0.7, topW, -glassH);
        ctx.closePath();
        ctx.clip();

        const sandGrad = ctx.createLinearGradient(-topW, topSandY, topW, -glassH);
        sandGrad.addColorStop(0, "rgba(30, 110, 240, 0.75)");
        sandGrad.addColorStop(0.4, "rgba(60, 150, 255, 0.9)");
        sandGrad.addColorStop(1, "rgba(100, 180, 255, 0.95)");

        ctx.beginPath();
        ctx.moveTo(-topW + 2, topSandY);
        ctx.quadraticCurveTo(0, topSandY - 4, topW - 2, topSandY);
        ctx.lineTo(topW - 2, -glassH);
        ctx.lineTo(-topW + 2, -glassH);
        ctx.closePath();
        ctx.fillStyle = sandGrad;
        ctx.fill();

        ctx.restore();
      }

      // Bottom bulb sand
      const botSandH = glassH * 0.82 * sandFraction;
      if (botSandH > 2) {
        const botSandTop = glassH - botSandH;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(-neckW, 0);
        ctx.bezierCurveTo(-neckW, glassH * 0.15, -bulgeX, glassH * 0.7, -topW, glassH);
        ctx.lineTo(topW, glassH);
        ctx.bezierCurveTo(bulgeX, glassH * 0.7, neckW, glassH * 0.15, neckW, 0);
        ctx.closePath();
        ctx.clip();

        const botGrad = ctx.createLinearGradient(-topW, botSandTop, topW, glassH);
        botGrad.addColorStop(0, "rgba(30, 110, 240, 0.7)");
        botGrad.addColorStop(0.5, "rgba(50, 140, 255, 0.85)");
        botGrad.addColorStop(1, "rgba(80, 160, 255, 0.92)");

        ctx.beginPath();
        ctx.moveTo(-topW + 2, botSandTop);
        ctx.quadraticCurveTo(0, botSandTop - 5, topW - 2, botSandTop);
        ctx.lineTo(topW - 2, glassH);
        ctx.lineTo(-topW + 2, glassH);
        ctx.closePath();
        ctx.fillStyle = botGrad;
        ctx.fill();

        // Sand shimmer
        const shimmerGrad = ctx.createLinearGradient(-topW, botSandTop, topW, botSandTop);
        shimmerGrad.addColorStop(0, "rgba(255,255,255,0)");
        shimmerGrad.addColorStop(0.4, "rgba(255,255,255,0.12)");
        shimmerGrad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = shimmerGrad;
        ctx.fill();

        ctx.restore();
      }

      // Caps (top and bottom plates)
      const capGrad = ctx.createLinearGradient(-topW - 6, 0, topW + 6, 0);
      capGrad.addColorStop(0, "rgba(40, 100, 220, 0.9)");
      capGrad.addColorStop(0.5, "rgba(100, 180, 255, 1)");
      capGrad.addColorStop(1, "rgba(40, 100, 220, 0.9)");

      [-glassH, glassH].forEach(capY => {
        ctx.beginPath();
        ctx.roundRect(-topW - 4, capY - 5, (topW + 4) * 2, 10, 3);
        ctx.fillStyle = capGrad;
        ctx.fill();
      });

      // Highlight streak on glass
      ctx.beginPath();
      ctx.moveTo(-topW * 0.6, -glassH + 8);
      ctx.bezierCurveTo(-bulgeX * 0.7, -glassH * 0.5, -neckW * 1.5, -glassH * 0.1, -neckW * 1.2, 0);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.restore();
    }

    function drawParticles() {
      particles.forEach((p, i) => {
        const alpha = 1 - p.life / p.maxLife;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 - p.life / p.maxLife * 0.5), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(80, 160, 255, ${alpha * 0.9})`;
        ctx.shadowColor = "rgba(80, 160, 255, 0.8)";
        ctx.shadowBlur = 6;
        ctx.fill();
        ctx.shadowBlur = 0;
        p.x += p.vx;
        p.y += p.vy;
        p.life++;
        if (p.life >= p.maxLife) {
          particles.splice(i, 1);
        }
      });
    }

    function drawRings() {
      const t = timeRef.current;
      for (let i = 0; i < 3; i++) {
        const phase = ((t * 0.008) + i * 0.33) % 1;
        const r = 8 + phase * (w * 0.52);
        const alpha = 0.25 * (1 - phase) * (1 - phase);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(60, 150, 255, ${alpha})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    function animate() {
      timeRef.current++;
      const t = timeRef.current;
      ctx.clearRect(0, 0, w, h);

      // Background ambient glow
      const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.55);
      bgGrad.addColorStop(0, "rgba(30, 90, 200, 0.08)");
      bgGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      drawRings();

      const cycleLen = 250;
      const phase = (t % cycleLen) / cycleLen;
      let rotation = 0;
      let sandFraction = phase;

      if (phase < 0.45) {
        rotation = 0;
        sandFraction = phase / 0.45;
      } else if (phase < 0.55) {
        const flipT = (phase - 0.45) / 0.1;
        rotation = flipT * Math.PI;
        sandFraction = 1;
      } else {
        rotation = Math.PI;
        sandFraction = 1 - (phase - 0.55) / 0.45;
      }

      drawHourglass(rotation, sandFraction);

      if (phase < 0.45 && t % 2 === 0) spawnParticle();
      if (phase > 0.55 && t % 2 === 0) spawnParticle();
      drawParticles();

      animRef.current = requestAnimationFrame(animate);
    }

    animate();

    return () => {
      cancelAnimationFrame(animRef.current);
    };
  }, [size]);

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="hourglass-container relative">
        <canvas ref={canvasRef} style={{ width: size, height: size }} />
        {/* Outer glow ring */}
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            background: "radial-gradient(circle, rgba(60,150,255,0.06) 0%, transparent 70%)",
          }}
        />
      </div>
      <div className="text-center space-y-2">
        <p className="text-base font-medium text-foreground/90">{message}</p>
        <div className="flex items-center justify-center gap-1.5">
          {[0, 1, 2].map(i => (
            <div
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-primary"
              style={{
                animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
