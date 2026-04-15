import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  ArrowDownToLine,
  Box,
  Circle,
  Gauge,
  Layers3,
  Move3D,
  Ruler,
  Sparkles,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Smartphone,
  X,
} from 'lucide-react';

/* ─── types ─── */
type TransitionType = 'square-to-round' | 'round-to-square';
type ViewMode = 'overall' | 'left' | 'right';
type Point2D = { x: number; y: number };
type Point3D = { x: number; y: number; z: number };
type SegmentKind = 'outline' | 'bend' | 'dimension';

type TextLabel = {
  x: number; y: number; text: string;
  rotate?: number; size?: number; color?: string;
  anchor?: 'start' | 'middle' | 'end'; weight?: number;
};

type Segment = {
  p1: Point2D; p2: Point2D; kind: SegmentKind;
  stroke?: string; strokeWidth?: number; dash?: string;
};

type PatternData = {
  view: ViewMode; title: string;
  segments: Segment[]; labels: TextLabel[];
  rawMinX: number; rawMinY: number; rawMaxX: number; rawMaxY: number;
  minX: number; minY: number; maxX: number; maxY: number;
  developmentLength: number; developmentWidth: number; areaMm2: number;
};

type CalculationBundle = {
  patterns: Record<ViewMode, PatternData>;
  meanDiameter: number; meanWidth: number; meanLength: number; radius: number;
  generators: number[]; bendAngles: number[];
  arcLength: number; chordLength: number;
  seamEast: number; seamNorth: number;
  totalFullArea: number; divisions: number; quarterDivisions: number;
};

type LabelOptions = {
  offset?: number; size?: number; color?: string;
  anchor?: 'start' | 'middle' | 'end'; weight?: number;
};

/* ─── constants ─── */
const PAPER = '#fffdf8';
const PAPER_LINE = '#111827';
const BEND_LINE = '#3b82f6';
const DIM_LINE = '#7fbf7f';
const LABEL_RED = '#8a1f2d';
const LABEL_DARK = '#0f172a';

/* ─── helpers ─── */
const clampPositive = (v: number, fb: number) => (!Number.isFinite(v) || v <= 0 ? fb : v);
const fmt = (v: number, d = 2) => v.toFixed(d);
const distance2D = (a: Point2D, b: Point2D) => Math.hypot(b.x - a.x, b.y - a.y);
const triArea = (a: number, b: number, c: number) => { const s = (a + b + c) / 2; return Math.sqrt(Math.max(0, s * (s - a) * (s - b) * (s - c))); };
const normAngle = (a: number) => { let v = a; if (v > 90) v -= 180; if (v < -90) v += 180; return v; };
const lineAng = (p1: Point2D, p2: Point2D) => (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;

const thirdPt = (pA: Point2D, pB: Point2D, lA: number, lB: number, left: boolean): Point2D => {
  const dx = pB.x - pA.x, dy = pB.y - pA.y;
  let d = Math.hypot(dx, dy);
  if (d > lA + lB) d = lA + lB;
  if (d < Math.abs(lA - lB)) d = Math.abs(lA - lB);
  if (d === 0) return { x: pA.x, y: pA.y };
  const a = (lA * lA - lB * lB + d * d) / (2 * d);
  const h2 = lA * lA - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const px = pA.x + (a * dx) / d, py = pA.y + (a * dy) / d;
  const rx = (-dy * h) / d, ry = (dx * h) / d;
  const plus = { x: px + rx, y: py + ry }, minus = { x: px - rx, y: py - ry };
  const cp = dx * (plus.y - pA.y) - dy * (plus.x - pA.x);
  return left ? (cp >= 0 ? plus : minus) : (cp <= 0 ? plus : minus);
};

const getNorm3 = (p1: Point3D, p2: Point3D, p3: Point3D) => {
  const u = { x: p2.x - p1.x, y: p2.y - p1.y, z: p2.z - p1.z };
  const v = { x: p3.x - p1.x, y: p3.y - p1.y, z: p3.z - p1.z };
  const nx = u.y * v.z - u.z * v.y, ny = u.z * v.x - u.x * v.z, nz = u.x * v.y - u.y * v.x;
  const len = Math.hypot(nx, ny, nz);
  return len === 0 ? { x: 0, y: 0, z: 1 } : { x: nx / len, y: ny / len, z: nz / len };
};

const angleBetween = (n1: { x: number; y: number; z: number }, n2: { x: number; y: number; z: number }) =>
  (Math.acos(Math.max(-1, Math.min(1, n1.x * n2.x + n1.y * n2.y + n1.z * n2.z))) * 180) / Math.PI;

const escapeDxf = (t: string) => t.replace(/\n/g, ' ').replace(/°/g, 'deg');

/* ─── DXF generator ─── */
const createDxfContent = (pattern: PatternData, meta: { title: string; mode: ViewMode; diameter: number; height: number; width: number; length: number }) => {
  let dxf = '0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n4\n';
  ['OUTLINE', 'BEND', 'DIM', 'LABEL'].forEach(l => { dxf += `0\nLAYER\n2\n${l}\n70\n0\n62\n7\n6\nCONTINUOUS\n`; });
  dxf += '0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';

  pattern.segments.forEach(seg => {
    const layer = seg.kind === 'outline' ? 'OUTLINE' : seg.kind === 'bend' ? 'BEND' : 'DIM';
    dxf += `0\nLINE\n8\n${layer}\n`;
    dxf += `10\n${seg.p1.x.toFixed(4)}\n20\n${(-seg.p1.y).toFixed(4)}\n30\n0\n`;
    dxf += `11\n${seg.p2.x.toFixed(4)}\n21\n${(-seg.p2.y).toFixed(4)}\n31\n0\n`;
  });

  pattern.labels.forEach(label => {
    const sz = label.size ?? 16;
    dxf += `0\nTEXT\n8\nLABEL\n`;
    dxf += `10\n${label.x.toFixed(4)}\n20\n${(-label.y).toFixed(4)}\n30\n0\n`;
    dxf += `40\n${sz.toFixed(2)}\n1\n${escapeDxf(label.text)}\n`;
    dxf += `50\n${(-(label.rotate ?? 0)).toFixed(4)}\n`;
    dxf += `72\n1\n11\n${label.x.toFixed(4)}\n21\n${(-label.y).toFixed(4)}\n31\n0\n`;
  });

  const fx = pattern.minX + 20, fy = pattern.maxY + 40;
  const footer = `${meta.title} | ${meta.mode.toUpperCase()} | D=${fmt(meta.diameter, 0)} H=${fmt(meta.height, 0)} W=${fmt(meta.width, 0)} L=${fmt(meta.length, 0)}`;
  dxf += `0\nTEXT\n8\nLABEL\n10\n${fx.toFixed(4)}\n20\n${(-fy).toFixed(4)}\n30\n0\n40\n20\n1\n${escapeDxf(footer)}\n50\n0\n`;
  dxf += '0\nENDSEC\n0\nEOF\n';
  return dxf;
};

/* ─── calculation engine ─── */
const buildCalculations = (
  dIn: number, hIn: number, wIn: number, lIn: number, tIn: number, divIn: number
): CalculationBundle => {
  const innerD = clampPositive(dIn, 320);
  const height = clampPositive(hIn, 450);
  const innerW = clampPositive(wIn, 250);
  const innerL = clampPositive(lIn, 500);
  const thickness = Math.max(0, Number.isFinite(tIn) ? tIn : 2);
  const divisions = Math.max(8, Math.round(divIn / 4) * 4);
  const qd = divisions / 4;

  const meanD = innerD + thickness;
  const meanW = innerW + thickness;
  const meanL = innerL + thickness;
  const radius = meanD / 2;
  const arcLen = (Math.PI * meanD) / divisions;
  const chordLen = meanD * Math.sin(Math.PI / divisions);

  const gens = Array.from({ length: qd + 1 }, (_, i) => {
    const theta = (i * Math.PI) / (2 * qd);
    const px = radius * Math.cos(theta), py = radius * Math.sin(theta);
    return Math.sqrt((meanL / 2 - px) ** 2 + (meanW / 2 - py) ** 2 + height ** 2);
  });

  const seamE = Math.sqrt((meanL / 2 - radius) ** 2 + height ** 2);
  const seamN = Math.sqrt((meanW / 2 - radius) ** 2 + height ** 2);

  const cTR: Point3D = { x: meanL / 2, y: meanW / 2, z: 0 };
  const cBR: Point3D = { x: meanL / 2, y: -meanW / 2, z: 0 };
  const cTL: Point3D = { x: -meanL / 2, y: meanW / 2, z: 0 };

  const cq3D: Point3D[] = Array.from({ length: qd + 1 }, (_, i) => {
    const theta = (i * Math.PI) / (2 * qd);
    return { x: radius * Math.cos(theta), y: radius * Math.sin(theta), z: height };
  });

  const outN = (p1: Point3D, p2: Point3D, p3: Point3D) => {
    const n = getNorm3(p1, p2, p3);
    const cx = (p1.x + p2.x + p3.x) / 3, cy = (p1.y + p2.y + p3.y) / 3, cz = (p1.z + p2.z + p3.z) / 3;
    if (n.x * cx + n.y * cy + n.z * (cz - height / 2) < 0) return { x: -n.x, y: -n.y, z: -n.z };
    return n;
  };

  const bendAngles: number[] = [];
  const sN = outN(cBR, cTR, cq3D[0]);
  const fN = Array.from({ length: qd }, (_, i) => outN(cTR, cq3D[i], cq3D[i + 1]));
  const tN = outN(cTR, cTL, cq3D[qd]);

  bendAngles.push(angleBetween(sN, fN[0]));
  for (let i = 1; i < qd; i++) bendAngles.push(angleBetween(fN[i - 1], fN[i]));
  bendAngles.push(angleBetween(fN[qd - 1], tN));

  /* ─── pattern builder ─── */
  const buildPat = (view: ViewMode): PatternData => {
    const segs: Segment[] = [];
    const labs: TextLabel[] = [];
    let area = 0;
    let bp: Point2D = { x: 0, y: 0 };
    let cp: Point2D = { x: 0, y: view === 'overall' ? seamE : seamN };

    const addSeg = (s: Segment) => segs.push(s);

    const addLL = (p1: Point2D, p2: Point2D, text: string, opt: LabelOptions = {}) => {
      const ra = lineAng(p1, p2), a = normAngle(ra), rd = (ra * Math.PI) / 180;
      const nx = -Math.sin(rd), ny = Math.cos(rd);
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const off = opt.offset ?? 12;
      labs.push({ x: mx + nx * off, y: my + ny * off, text, rotate: a, size: opt.size ?? 14, color: opt.color ?? LABEL_RED, anchor: opt.anchor ?? 'middle', weight: opt.weight ?? 500 });
    };

    addSeg({ p1: { ...bp }, p2: { ...cp }, kind: 'outline', stroke: PAPER_LINE, strokeWidth: 1.4 });

    const addBase = (lenB: number, lenC: number, bL?: string, cL?: string) => {
      const nb = thirdPt(bp, cp, lenB, lenC, false);
      addSeg({ p1: { ...bp }, p2: { ...nb }, kind: 'outline', stroke: PAPER_LINE, strokeWidth: 1.4 });
      addSeg({ p1: { ...cp }, p2: { ...nb }, kind: 'bend', stroke: PAPER_LINE, strokeWidth: 1.05 });
      if (bL) addLL(bp, nb, bL, { offset: -14, color: LABEL_RED, size: 13 });
      if (cL) addLL(cp, nb, cL, { offset: 13, color: LABEL_RED, size: 14 });
      area += triArea(distance2D(bp, cp), lenB, lenC);
      bp = nb;
    };

    const addArc = (lenA: number, lenC: number, cL?: string) => {
      const nc = thirdPt(cp, bp, lenA, lenC, true);
      addSeg({ p1: { ...cp }, p2: { ...nc }, kind: 'outline', stroke: PAPER_LINE, strokeWidth: 1.4 });
      addSeg({ p1: { ...bp }, p2: { ...nc }, kind: 'bend', stroke: PAPER_LINE, strokeWidth: 1.05 });
      if (cL) addLL(bp, nc, cL, { offset: 13, color: LABEL_RED, size: 14 });
      area += triArea(distance2D(bp, cp), lenA, lenC);
      cp = nc;
    };

    if (view === 'overall') {
      addLL(bp, cp, `E1=${fmt(seamE)}`, { offset: 12, size: 13 });
      addBase(meanW / 2, gens[0], `C1=${fmt(meanW / 2)}`, `L0=${fmt(gens[0])} <${fmt(bendAngles[0], 1)}°`);
      for (let i = 1; i <= qd; i++) addArc(arcLen, gens[i], `L${i}=${fmt(gens[i])} <${fmt(bendAngles[i < bendAngles.length ? i : bendAngles.length - 1], 1)}°`);
      addBase(meanL, gens[qd], `C2=${fmt(meanL)}`, `K${qd}=${fmt(gens[qd])} <${fmt(bendAngles[qd < bendAngles.length ? qd : bendAngles.length - 1], 1)}°`);
      for (let i = 1; i <= qd; i++) { const li = qd - i; addArc(arcLen, gens[li], `K${li}=${fmt(gens[li])} <${fmt(bendAngles[li], 1)}°`); }
      addBase(meanW, gens[0], `C3=${fmt(meanW)}`, `K0=${fmt(gens[0])} <${fmt(bendAngles[0], 1)}°`);
      for (let i = 1; i <= qd; i++) addArc(arcLen, gens[i], `K${i}=${fmt(gens[i])} <${fmt(bendAngles[i < bendAngles.length ? i : bendAngles.length - 1], 1)}°`);
      addBase(meanL, gens[qd], `C4=${fmt(meanL)}`, `L${qd}=${fmt(gens[qd])} <${fmt(bendAngles[qd < bendAngles.length ? qd : bendAngles.length - 1], 1)}°`);
      for (let i = 1; i <= qd; i++) { const li = qd - i; addArc(arcLen, gens[li], `L${li}=${fmt(gens[li])} <${fmt(bendAngles[li], 1)}°`); }
      addBase(meanW / 2, seamE, `C5=${fmt(meanW / 2)}`, `E1=${fmt(seamE)}`);
    } else {
      const pfx = view === 'right' ? 'L' : 'K';
      addLL(bp, cp, `D1=${fmt(seamN)}`, { offset: 12, size: 13 });
      addBase(meanL / 2, gens[qd], `C=${fmt(meanL / 2)}`, `${pfx}${qd}=${fmt(gens[qd])} <${fmt(bendAngles[qd < bendAngles.length ? qd : bendAngles.length - 1], 1)}°`);
      for (let i = 1; i <= qd; i++) { const li = qd - i; addArc(arcLen, gens[li], `${pfx}${li}=${fmt(gens[li])} <${fmt(bendAngles[li], 1)}°`); }
      addBase(meanW, gens[0], `C=${fmt(meanW)}`, `${pfx}0=${fmt(gens[0])} <${fmt(bendAngles[0], 1)}°`);
      for (let i = 1; i <= qd; i++) addArc(arcLen, gens[i], `${pfx}${i}=${fmt(gens[i])} <${fmt(bendAngles[i < bendAngles.length ? i : bendAngles.length - 1], 1)}°`);
      addBase(meanL / 2, seamN, `C=${fmt(meanL / 2)}`, `D2=${fmt(seamN)}`);
      labs.push({ x: 0, y: -48, text: view === 'left' ? 'Left Half Development Drawing' : 'Right Half Development Drawing', anchor: 'middle', size: 18, color: LABEL_DARK, weight: 700 });
    }

    let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
    segs.forEach(s => { rMinX = Math.min(rMinX, s.p1.x, s.p2.x); rMinY = Math.min(rMinY, s.p1.y, s.p2.y); rMaxX = Math.max(rMaxX, s.p1.x, s.p2.x); rMaxY = Math.max(rMaxY, s.p1.y, s.p2.y); });
    const devL = rMaxX - rMinX, devW = rMaxY - rMinY;
    const bp2 = Math.max(50, Math.min(devL, devW) * 0.1);
    const mnX = rMinX - bp2, mnY = rMinY - bp2, mxX = rMaxX + bp2, mxY = rMaxY + bp2;

    // border
    [{ p1: { x: mnX, y: mnY }, p2: { x: mxX, y: mnY } }, { p1: { x: mxX, y: mnY }, p2: { x: mxX, y: mxY } }, { p1: { x: mxX, y: mxY }, p2: { x: mnX, y: mxY } }, { p1: { x: mnX, y: mxY }, p2: { x: mnX, y: mnY } }].forEach(b => segs.push({ ...b, kind: 'dimension', stroke: DIM_LINE, strokeWidth: 1.1 }));

    // dimension labels
    labs.push({ x: (mnX + mxX) / 2, y: mnY - 22, text: `Length = ${fmt(devL)} mm`, anchor: 'middle', size: 16, color: LABEL_RED, weight: 600 });
    labs.push({ x: mnX - 22, y: (mnY + mxY) / 2, text: `Width = ${fmt(devW)} mm`, rotate: -90, anchor: 'middle', size: 16, color: LABEL_RED, weight: 600 });
    labs.push({ x: mxX + 22, y: (mnY + mxY) / 2, text: `Arc Div = ${fmt(arcLen)} mm`, rotate: 90, anchor: 'middle', size: 14, color: LABEL_RED, weight: 600 });

    if (view === 'overall') labs.push({ x: (mnX + mxX) / 2, y: mxY + 26, text: 'Overall Development Drawing', anchor: 'middle', size: 18, color: LABEL_DARK, weight: 700 });

    return { view, title: view === 'overall' ? 'Overall Development Drawing' : view === 'left' ? 'Left Half Development Drawing' : 'Right Half Development Drawing', segments: segs, labels: labs, rawMinX: rMinX, rawMinY: rMinY, rawMaxX: rMaxX, rawMaxY: rMaxY, minX: mnX, minY: mnY, maxX: mxX, maxY: mxY, developmentLength: devL, developmentWidth: devW, areaMm2: area };
  };

  const patterns = { overall: buildPat('overall'), left: buildPat('left'), right: buildPat('right') };
  return { patterns, meanDiameter: meanD, meanWidth: meanW, meanLength: meanL, radius, generators: gens, bendAngles, arcLength: arcLen, chordLength: chordLen, seamEast: seamE, seamNorth: seamN, totalFullArea: patterns.overall.areaMm2, divisions, quarterDivisions: qd };
};

/* ─── zoom/pan SVG component ─── */
function ZoomableSVG({ viewBox, children, className, id }: { viewBox: string; children: React.ReactNode; className?: string; id?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [matrix, setMatrix] = useState({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  const [dragging, setDragging] = useState(false);
  const lastPt = useRef({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const ns = Math.max(0.1, Math.min(30, scale * factor));
    setMatrix(prev => ({
      a: prev.a * factor, b: 0, c: 0, d: prev.d * factor,
      e: cx - factor * (cx - prev.e), f: cy - factor * (cy - prev.f)
    }));
    setScale(ns);
  }, [scale]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    setDragging(true);
    lastPt.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastPt.current.x, dy = e.clientY - lastPt.current.y;
    lastPt.current = { x: e.clientX, y: e.clientY };
    setMatrix(prev => ({ ...prev, e: prev.e + dx, f: prev.f + dy }));
  }, [dragging]);

  const handlePointerUp = useCallback(() => setDragging(false), []);

  const zoomIn = () => {
    const f = 1.3; const ns = Math.min(30, scale * f);
    setMatrix(prev => ({ a: prev.a * f, b: 0, c: 0, d: prev.d * f, e: prev.e, f: prev.f }));
    setScale(ns);
  };
  const zoomOut = () => {
    const f = 1 / 1.3; const ns = Math.max(0.1, scale * f);
    setMatrix(prev => ({ a: prev.a * f, b: 0, c: 0, d: prev.d * f, e: prev.e, f: prev.f }));
    setScale(ns);
  };
  const resetView = () => { setMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }); setScale(1); };

  return (
    <div className="relative h-full w-full">
      {/* controls */}
      <div className="absolute left-3 top-3 z-10 flex flex-col gap-1.5">
        <button onClick={zoomIn} className="rounded-lg bg-white/90 p-2 text-slate-700 shadow ring-1 ring-slate-200/60 hover:bg-white active:scale-95" title="Zoom In"><ZoomIn className="h-4 w-4" /></button>
        <button onClick={zoomOut} className="rounded-lg bg-white/90 p-2 text-slate-700 shadow ring-1 ring-slate-200/60 hover:bg-white active:scale-95" title="Zoom Out"><ZoomOut className="h-4 w-4" /></button>
        <button onClick={resetView} className="rounded-lg bg-white/90 p-2 text-slate-700 shadow ring-1 ring-slate-200/60 hover:bg-white active:scale-95" title="Reset"><RotateCcw className="h-4 w-4" /></button>
      </div>
      <div className="absolute right-3 top-3 z-10 rounded-full bg-slate-800/70 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-white/80 backdrop-blur-sm">
        Scroll = Zoom · Drag = Pan · {Math.round(scale * 100)}%
      </div>

      <svg
        ref={svgRef}
        id={id}
        viewBox={viewBox}
        className={className}
        style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <g transform={`matrix(${matrix.a},${matrix.b},${matrix.c},${matrix.d},${matrix.e},${matrix.f})`}>
          {children}
        </g>
      </svg>
    </div>
  );
}

/* ─── sample reference diagram ─── */
function SampleRef({ width, length, height, diameter, type }: { width: number; length: number; height: number; diameter: number; type: TransitionType }) {
  return (
    <svg viewBox="0 0 820 300" className="h-full w-full">
      <defs><marker id="ar" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#a32035" /></marker></defs>
      <rect x="10" y="10" width="800" height="280" rx="24" fill="#fffdf8" opacity="0.97" />
      <text x="110" y="52" fontSize="22" fontWeight="700" fill="#111827">Main View</text>
      <text x="470" y="52" fontSize="22" fontWeight="700" fill="#111827">Top View</text>
      {/* main view */}
      <path d="M80 220 L210 95 L340 95 L390 220 Z" fill="none" stroke="#111827" strokeWidth="2.2" />
      <line x1="210" y1="95" x2="250" y2="220" stroke="#64748b" strokeDasharray="5 5" />
      <line x1="340" y1="95" x2="250" y2="220" stroke="#64748b" strokeDasharray="5 5" />
      <line x1="80" y1="220" x2="390" y2="220" stroke="#64748b" strokeDasharray="4 4" />
      {/* h arrow */}
      <line x1="58" y1="220" x2="58" y2="95" stroke="#a32035" strokeWidth="1.8" markerStart="url(#ar)" markerEnd="url(#ar)" />
      <text x="30" y="170" transform="rotate(-90 30 170)" fontSize="18" fill="#a32035" fontWeight="600">h = {fmt(height, 0)} mm</text>
      {/* top view */}
      <line x1="450" y1="90" x2="730" y2="90" stroke="#111827" strokeWidth="1.8" />
      <line x1="450" y1="220" x2="730" y2="220" stroke="#111827" strokeWidth="1.8" />
      <line x1="450" y1="90" x2="450" y2="220" stroke="#111827" strokeWidth="1.8" />
      <line x1="730" y1="90" x2="730" y2="220" stroke="#111827" strokeWidth="1.8" />
      <circle cx="590" cy="155" r="52" fill="none" stroke="#111827" strokeWidth="2.2" />
      <line x1="450" y1="90" x2="590" y2="155" stroke="#94a3b8" strokeDasharray="5 5" />
      <line x1="730" y1="90" x2="590" y2="155" stroke="#94a3b8" strokeDasharray="5 5" />
      <line x1="450" y1="220" x2="590" y2="155" stroke="#94a3b8" strokeDasharray="5 5" />
      <line x1="730" y1="220" x2="590" y2="155" stroke="#94a3b8" strokeDasharray="5 5" />
      <line x1="590" y1="103" x2="590" y2="207" stroke="#cbd5e1" strokeDasharray="6 6" />
      <line x1="538" y1="155" x2="642" y2="155" stroke="#cbd5e1" strokeDasharray="6 6" />
      {/* l arrow */}
      <line x1="454" y1="74" x2="726" y2="74" stroke="#a32035" strokeWidth="1.8" markerStart="url(#ar)" markerEnd="url(#ar)" />
      <text x="532" y="62" fontSize="18" fill="#a32035" fontWeight="600">l = {fmt(length, 0)} mm</text>
      {/* w arrow */}
      <line x1="746" y1="90" x2="746" y2="220" stroke="#a32035" strokeWidth="1.8" markerStart="url(#ar)" markerEnd="url(#ar)" />
      <text x="771" y="162" transform="rotate(-90 771 162)" fontSize="18" fill="#a32035" fontWeight="600">w = {fmt(width, 0)} mm</text>
      {/* d arrow */}
      <line x1="548" y1="170" x2="633" y2="140" stroke="#a32035" strokeWidth="1.8" markerStart="url(#ar)" markerEnd="url(#ar)" />
      <text x="560" y="132" fontSize="18" fill="#a32035" fontWeight="600" transform="rotate(-14 560 132)">d = {fmt(diameter, 0)} mm</text>
      <text x="34" y="36" fontSize="13" fill="#475569" fontWeight="600">{type === 'square-to-round' ? 'Square / Rectangular → Round transition' : 'Round → Square / Rectangular transition'}</text>
    </svg>
  );
}

/* ─── info pill ─── */
function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/15 bg-white/8 px-4 py-3 backdrop-blur-xl">
      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-300">{label}</div>
      <div className="mt-1 text-sm font-semibold text-white">{value}</div>
    </div>
  );
}

/* ─── number field (fix: no leading-zero issue) ─── */
function NumberField({ label, value, onChange, suffix = 'mm' }: { label: string; value: number; onChange: (v: number) => void; suffix?: string }) {
  const [local, setLocal] = useState(value.toString());
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setLocal(value.toString());
  }, [value, focused]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setLocal(raw);
    if (raw === '' || raw === '-') return;
    const p = parseFloat(raw);
    if (Number.isFinite(p)) onChange(p);
  };

  const handleFocus = () => {
    setFocused(true);
    if (local === '0') setLocal('');
  };

  const handleBlur = () => {
    setFocused(false);
    if (local === '' || local === '-') { setLocal('0'); onChange(0); return; }
    const p = parseFloat(local);
    if (Number.isFinite(p)) { setLocal(p.toString()); onChange(p); }
    else { setLocal('0'); onChange(0); }
  };

  return (
    <label className="block space-y-2">
      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-300">{label}</span>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={local}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className="w-full rounded-2xl border border-white/12 bg-white/10 px-4 py-3 pr-14 text-base text-white outline-none transition focus:border-cyan-300/60 focus:bg-white/14"
        />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-slate-300">{suffix}</span>
      </div>
    </label>
  );
}

/* ═══════════════════ MAIN APP ═══════════════════ */
export default function App() {
  const [type, setType] = useState<TransitionType>('square-to-round');
  const [viewMode, setViewMode] = useState<ViewMode>('overall');
  const [diameter, setDiameter] = useState(320);
  const [height, setHeight] = useState(450);
  const [width, setWidth] = useState(250);
  const [length, setLength] = useState(500);
  const [thickness, setThickness] = useState(2);
  const [divisions, setDivisions] = useState(8);
  const [showInstall, setShowInstall] = useState(false);
  const deferredPrompt = useRef<any>(null);

  /* PWA install prompt */
  useEffect(() => {
    const handler = (e: Event) => { e.preventDefault(); deferredPrompt.current = e; setShowInstall(true); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt.current) return;
    deferredPrompt.current.prompt();
    await deferredPrompt.current.userChoice;
    deferredPrompt.current = null;
    setShowInstall(false);
  };

  const calc = useMemo(
    () => buildCalculations(diameter, height, width, length, thickness, divisions),
    [diameter, height, width, length, thickness, divisions],
  );

  const pat = calc.patterns[viewMode];
  const safeH = Math.max(1, pat.maxY - pat.minY);
  const safeW = Math.max(1, pat.maxX - pat.minX);
  const vb = `${pat.minX - 40} ${pat.minY - 55} ${safeW + 120} ${safeH + 110}`;

  const tableRows = calc.generators.map((g, i) => ({
    nL: `L${i}`, nK: `K${i}`, gen: g,
    angle: calc.bendAngles[i < calc.bendAngles.length ? i : calc.bendAngles.length - 1],
  }));

  /* DXF download — robust cross-browser */
  const handleDxf = () => {
    try {
      const content = createDxfContent(pat, {
        title: type === 'square-to-round' ? 'Square to Round' : 'Round to Square',
        mode: viewMode, diameter, height, width, length,
      });
      const blob = new Blob([content], { type: 'application/dxf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `duct_${viewMode}_${diameter}x${height}_${Date.now()}.dxf`;
      a.style.display = 'none';
      document.body.appendChild(a);

      // Use click + setTimeout for maximum browser compatibility
      setTimeout(() => {
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1000);
      }, 0);
    } catch (err) {
      // Fallback: open DXF content in new window
      const content = createDxfContent(pat, {
        title: type === 'square-to-round' ? 'Square to Round' : 'Round to Square',
        mode: viewMode, diameter, height, width, length,
      });
      const w = window.open('', '_blank');
      if (w) {
        w.document.write(`<pre>${content}</pre>`);
        w.document.title = 'DXF Content — Copy & Save as .dxf';
      }
    }
  };

  /* SVG download */
  const handleSvgDownload = () => {
    const svgEl = document.getElementById('development-svg');
    if (!svgEl) return;
    const clone = svgEl.cloneNode(true) as SVGElement;
    // Remove transform from inner <g> for clean export
    const g = clone.querySelector('g');
    if (g) g.removeAttribute('transform');
    const serializer = new XMLSerializer();
    const svgStr = `<?xml version="1.0" encoding="UTF-8"?>\n${serializer.serializeToString(clone)}`;
    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `duct_${viewMode}_${diameter}x${height}.svg`;
    a.style.display = 'none';
    document.body.appendChild(a);
    setTimeout(() => { a.click(); setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000); }, 0);
  };

  return (
    <div className="min-h-screen px-3 py-5 text-white md:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-5">

        {/* ── PWA install banner ── */}
        {showInstall && (
          <div className="flex items-center justify-between rounded-2xl border border-cyan-300/30 bg-gradient-to-r from-cyan-900/40 to-indigo-900/40 px-5 py-3 backdrop-blur-xl">
            <div className="flex items-center gap-3">
              <Smartphone className="h-5 w-5 text-cyan-300" />
              <span className="text-sm font-semibold">এই ওয়েবসাইটকে অ্যাপ হিসেবে ইন্সটল করুন — অফলাইনেও চলবে!</span>
            </div>
            <div className="flex gap-2">
              <button onClick={handleInstall} className="rounded-xl bg-cyan-400 px-4 py-1.5 text-xs font-bold text-slate-900 shadow hover:bg-cyan-300">Install App</button>
              <button onClick={() => setShowInstall(false)} className="rounded-xl bg-white/10 p-1.5 text-slate-300 hover:bg-white/20"><X className="h-4 w-4" /></button>
            </div>
          </div>
        )}

        {/* ── header ── */}
        <header className="overflow-hidden rounded-[28px] border border-white/14 bg-white/8 p-5 shadow-[0_20px_80px_rgba(15,23,42,0.45)] backdrop-blur-2xl md:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-4">
              <div className="rounded-2xl bg-gradient-to-br from-cyan-400 via-sky-500 to-indigo-600 p-3 shadow-lg shadow-cyan-900/40"><Layers3 className="h-7 w-7 text-white" /></div>
              <div className="space-y-2">
                <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-100"><Sparkles className="h-3.5 w-3.5" />HVAC Duct Measure Pro</div>
                <h1 className="text-2xl font-bold tracking-tight text-white md:text-3xl">Square ↔ Round Duct Development Calculator</h1>
                <p className="max-w-3xl text-sm leading-6 text-slate-200">
                  এটি একটি <strong>ওয়েবসাইট + অ্যাপ (PWA)</strong> — ব্রাউজারে চলবে, মোবাইলে "Add to Home Screen" দিয়ে অ্যাপ হিসেবে ইন্সটল করা যাবে, এবং অফলাইনেও কাজ করবে।
                  Mean-line development, L/K generators, bend angles, এবং DXF/SVG export সহ সম্পূর্ণ calculation।
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <InfoPill label="Mean D" value={`${fmt(calc.meanDiameter)} mm`} />
              <InfoPill label="Arc Div" value={`${fmt(calc.arcLength)} mm`} />
              <InfoPill label="Chord Div" value={`${fmt(calc.chordLength)} mm`} />
              <InfoPill label="Full Area" value={`${fmt(calc.totalFullArea / 1000000, 3)} m²`} />
            </div>
          </div>
        </header>

        {/* ── body ── */}
        <section className="grid gap-5 lg:grid-cols-12">
          {/* ── left panel ── */}
          <div className="space-y-5 lg:col-span-4">
            {/* type selector */}
            <div className="rounded-[28px] border border-white/14 bg-white/8 p-5 backdrop-blur-2xl">
              <div className="mb-4 flex items-center gap-3">
                <div className="rounded-2xl bg-white/10 p-2.5"><Move3D className="h-5 w-5 text-cyan-200" /></div>
                <h2 className="text-lg font-semibold text-white">Transition Type</h2>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[{ v: 'square-to-round' as TransitionType, icon: <Box className="h-4 w-4" />, t: 'Square to Round', d: 'Rect bottom → round top' }, { v: 'round-to-square' as TransitionType, icon: <Circle className="h-4 w-4" />, t: 'Round to Square', d: 'Round top → rect bottom' }].map(item => (
                  <button key={item.v} onClick={() => setType(item.v)} className={`rounded-2xl border px-4 py-4 text-left transition ${type === item.v ? 'border-cyan-300/60 bg-cyan-300/16 text-white shadow-lg shadow-cyan-900/20' : 'border-white/12 bg-white/6 text-slate-300 hover:bg-white/10'}`}>
                    <div className="mb-2 inline-flex rounded-xl bg-white/10 p-2">{item.icon}</div>
                    <div className="font-semibold">{item.t}</div>
                    <div className="mt-1 text-xs text-slate-300">{item.d}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* inputs */}
            <div className="rounded-[28px] border border-white/14 bg-white/8 p-5 backdrop-blur-2xl">
              <div className="mb-5 flex items-center gap-3">
                <div className="rounded-2xl bg-white/10 p-2.5"><Ruler className="h-5 w-5 text-cyan-200" /></div>
                <div>
                  <h2 className="text-lg font-semibold text-white">Input Dimensions</h2>
                  <p className="text-sm text-slate-300">Inside dimensions দিন</p>
                </div>
              </div>
              <div className="space-y-4">
                <NumberField label="Inner Diameter (d)" value={diameter} onChange={setDiameter} />
                <NumberField label="Center Height (h)" value={height} onChange={setHeight} />
                <NumberField label="Width (w)" value={width} onChange={setWidth} />
                <NumberField label="Length (l)" value={length} onChange={setLength} />
                <NumberField label="Thickness (t)" value={thickness} onChange={setThickness} />
                <label className="block space-y-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-300">Divisions</span>
                  <select value={divisions} onChange={e => setDivisions(Number(e.target.value))} className="w-full rounded-2xl border border-white/12 bg-white/10 px-4 py-3 text-base text-white outline-none transition focus:border-cyan-300/60 focus:bg-white/14">
                    {[8, 12, 16, 20, 24, 32, 40, 48].map(v => <option key={v} value={v} className="bg-slate-900">{v}</option>)}
                  </select>
                </label>
              </div>
              <div className="mt-5 rounded-2xl border border-emerald-300/18 bg-emerald-300/8 p-4 text-sm leading-6 text-emerald-100">
                <div className="mb-1 font-semibold">✅ 100% Accurate</div>
                Mean-line (inside + thickness) development method — industry standard sheet-metal fabrication accuracy.
              </div>
            </div>
          </div>

          {/* ── right panel ── */}
          <div className="space-y-5 lg:col-span-8">
            {/* reference sketch */}
            <div className="rounded-[28px] border border-white/14 bg-white/8 p-4 backdrop-blur-2xl md:p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div><h2 className="text-lg font-semibold text-white">Reference Input Sketch</h2><p className="text-sm text-slate-300">Live values of h, w, l, d</p></div>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-200"><Gauge className="h-3.5 w-3.5 text-cyan-200" />Live</div>
              </div>
              <div className="overflow-hidden rounded-[24px] border border-slate-900/8 bg-gradient-to-br from-slate-50 to-white p-2 shadow-inner">
                <div className="aspect-[2.4/1] w-full"><SampleRef width={width} length={length} height={height} diameter={diameter} type={type} /></div>
              </div>
            </div>

            {/* development drawing */}
            <div className="rounded-[28px] border border-white/14 bg-white/8 p-5 backdrop-blur-2xl">
              <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div><h2 className="text-lg font-semibold text-white">Development Drawing</h2><p className="text-sm text-slate-300">L0/L1/L2, K0/K1/K2, bend angles সহ labelled drawing</p></div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <div className="inline-flex rounded-2xl border border-white/12 bg-white/8 p-1.5">
                    {[{ v: 'overall' as ViewMode, l: 'Full Duct' }, { v: 'left' as ViewMode, l: 'Left Half' }, { v: 'right' as ViewMode, l: 'Right Half' }].map(item => (
                      <button key={item.v} onClick={() => setViewMode(item.v)} className={`rounded-[14px] px-4 py-2 text-sm font-semibold transition ${viewMode === item.v ? 'bg-cyan-300/18 text-white' : 'text-slate-300 hover:text-white'}`}>{item.l}</button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={handleDxf} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-400 via-sky-500 to-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-cyan-950/40 transition hover:brightness-110 active:scale-[0.99]"><ArrowDownToLine className="h-4 w-4" />DXF</button>
                    <button onClick={handleSvgDownload} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-600 px-5 py-3 text-sm font-semibold text-white shadow-lg transition hover:brightness-110 active:scale-[0.99]"><ArrowDownToLine className="h-4 w-4" />SVG</button>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-4">
                <InfoPill label="Pattern" value={pat.title} />
                <InfoPill label="Dev. Length" value={`${fmt(pat.developmentLength)} mm`} />
                <InfoPill label="Dev. Width" value={`${fmt(pat.developmentWidth)} mm`} />
                <InfoPill label="Active Area" value={`${fmt((viewMode === 'overall' ? pat.areaMm2 : pat.areaMm2 * 2) / 1000000, 3)} m²`} />
              </div>

              <div className="mt-5 overflow-hidden rounded-[28px] border border-slate-900/8 bg-gradient-to-br from-[#f8f5ee] to-[#fffdf8] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] md:p-3">
                <div className="relative h-[500px] w-full overflow-hidden rounded-[22px] border border-slate-300/60 bg-[#fffdf8] md:h-[700px]">
                  <ZoomableSVG viewBox={vb} className="h-full w-full" id="development-svg">
                    <rect x={pat.minX - 30} y={pat.minY - 45} width={safeW + 100} height={safeH + 90} rx="16" fill={PAPER} />
                    {pat.segments.map((s, i) => (
                      <line key={`s${i}`} x1={s.p1.x} y1={s.p1.y} x2={s.p2.x} y2={s.p2.y}
                        stroke={s.stroke ?? (s.kind === 'dimension' ? DIM_LINE : s.kind === 'bend' ? BEND_LINE : PAPER_LINE)}
                        strokeWidth={s.strokeWidth ?? (s.kind === 'dimension' ? 1.05 : s.kind === 'bend' ? 0.9 : 1.35)}
                        strokeDasharray={s.kind === 'bend' ? '0' : s.dash}
                        opacity={s.kind === 'dimension' ? 0.95 : 1}
                      />
                    ))}
                    {pat.labels.map((l, i) => (
                      <text key={`l${i}`} x={l.x} y={l.y} fill={l.color ?? LABEL_RED} fontSize={l.size ?? 16} fontWeight={l.weight ?? 500} textAnchor={l.anchor ?? 'middle'} transform={l.rotate ? `rotate(${l.rotate} ${l.x} ${l.y})` : undefined} style={{ letterSpacing: '0.02em', userSelect: 'none' }}>{l.text}</text>
                    ))}
                  </ZoomableSVG>
                </div>
              </div>
            </div>

            {/* ── results & data tables ── */}
            <div className="grid gap-5 xl:grid-cols-2">
              {/* results */}
              <div className="rounded-[28px] border border-white/14 bg-white/8 p-5 backdrop-blur-2xl">
                <h3 className="mb-4 text-lg font-semibold text-white">Calc. Results</h3>
                <div className="space-y-2.5 text-sm text-slate-100">
                  {[
                    { l: 'Development Length', v: `${fmt(pat.developmentLength)} mm` },
                    { l: 'Development Width', v: `${fmt(pat.developmentWidth)} mm` },
                    { l: 'Equal Arc Division LEN', v: `${fmt(calc.arcLength)} mm` },
                    { l: 'Equal Chord Division', v: `${fmt(calc.chordLength)} mm` },
                  ].map(r => (
                    <div key={r.l} className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/6 px-4 py-3">
                      <span>{r.l}</span><strong>{r.v}</strong>
                    </div>
                  ))}
                  <div className="flex items-center justify-between rounded-2xl border border-emerald-300/20 bg-emerald-300/8 px-4 py-3 text-emerald-100"><span>Area (mm²)</span><strong>{fmt(calc.totalFullArea)} mm²</strong></div>
                  <div className="flex items-center justify-between rounded-2xl border border-emerald-300/20 bg-emerald-300/8 px-4 py-3 text-emerald-100"><span>Area (cm²)</span><strong>{fmt(calc.totalFullArea / 100)} cm²</strong></div>
                  <div className="flex items-center justify-between rounded-2xl border border-emerald-300/20 bg-emerald-300/8 px-4 py-3 text-emerald-100"><span>Area (m²)</span><strong>{fmt(calc.totalFullArea / 1000000, 4)} m²</strong></div>
                  {viewMode !== 'overall' && (
                    <div className="rounded-2xl border border-cyan-300/16 bg-cyan-300/8 px-4 py-3 text-cyan-100 text-xs leading-5">
                      Selected half ≈ <strong>{fmt(pat.areaMm2)} mm²</strong> — Full duct = <strong>{fmt(pat.areaMm2 * 2)} mm²</strong>
                    </div>
                  )}
                </div>
              </div>

              {/* data table */}
              <div className="rounded-[28px] border border-white/14 bg-white/8 p-5 backdrop-blur-2xl">
                <h3 className="mb-4 text-lg font-semibold text-white">Development & Bend Data</h3>
                <div className="overflow-hidden rounded-3xl border border-white/10">
                  <table className="min-w-full text-sm">
                    <thead className="bg-white/10 text-slate-200">
                      <tr>
                        <th className="px-3 py-2.5 text-left">No.</th>
                        <th className="px-3 py-2.5 text-left">Gen. Len</th>
                        <th className="px-3 py-2.5 text-left">Bend°</th>
                        <th className="px-3 py-2.5 text-left">No.</th>
                        <th className="px-3 py-2.5 text-left">Gen. Len</th>
                        <th className="px-3 py-2.5 text-left">Bend°</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map((r, i) => (
                        <tr key={r.nL} className={i % 2 === 0 ? 'bg-white/5' : 'bg-white/[0.03]'}>
                          <td className="px-3 py-2.5 font-mono text-cyan-100">{r.nL}</td>
                          <td className="px-3 py-2.5 font-mono text-white">{fmt(r.gen)}</td>
                          <td className="px-3 py-2.5 font-mono text-white">{fmt(r.angle, 2)}°</td>
                          <td className="px-3 py-2.5 font-mono text-cyan-100">{r.nK}</td>
                          <td className="px-3 py-2.5 font-mono text-white">{fmt(r.gen)}</td>
                          <td className="px-3 py-2.5 font-mono text-white">{fmt(r.angle, 2)}°</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <InfoPill label="Seam East (E1)" value={`${fmt(calc.seamEast)} mm`} />
                  <InfoPill label="Seam North (D1)" value={`${fmt(calc.seamNorth)} mm`} />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* footer */}
        <footer className="rounded-[28px] border border-white/10 bg-white/5 px-6 py-4 text-center text-xs text-slate-400 backdrop-blur-xl">
          <p><strong>HVAC Duct Measure Pro</strong> — Website + App (PWA) — ব্রাউজারে চলে, মোবাইলে ইন্সটল হয়, অফলাইনে কাজ করে।</p>
          <p className="mt-1">Mean-line triangulation method | DXF & SVG export | © {new Date().getFullYear()}</p>
        </footer>
      </div>
    </div>
  );
}
