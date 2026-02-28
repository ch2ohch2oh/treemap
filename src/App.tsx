import { useRef, useState, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import * as d3 from 'd3';
import './App.css';

// ── Types ──────────────────────────────────────────────────────────────────
type Row = Record<string, string | number>;

interface TreeNode {
  name: string;
  value?: number;
  children?: TreeNode[];
  row?: Row;
}

type RectNode = d3.HierarchyRectangularNode<TreeNode>;

// ── CSV parser ─────────────────────────────────────────────────────────────
function parseCSV(text: string): Row[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g) ?? [''];
    const row: Row = {};
    headers.forEach((h, i) => {
      const raw = (vals[i] ?? '').trim().replace(/^"|"$/g, '');
      const num = Number(raw.replace(/,/g, ''));
      row[h] = isNaN(num) || raw === '' ? raw : num;
    });
    return row;
  });
}

// ── Build hierarchy ────────────────────────────────────────────────────────
function buildHierarchy(rows: Row[], groupCols: string[], valueCol: string): TreeNode {
  const root: TreeNode = { name: 'root', children: [] };

  rows.forEach(row => {
    let node = root;
    groupCols.forEach(col => {
      const key = String(row[col] ?? 'Unknown');
      let child = node.children!.find(c => c.name === key);
      if (!child) {
        child = { name: key, children: [] };
        node.children!.push(child);
      }
      node = child;
    });
    const val = Number(row[valueCol]);
    if (!isNaN(val) && val > 0) {
      node.value = (node.value ?? 0) + val;
      if (!node.row) node.row = row;
    }
  });

  function prune(n: TreeNode): TreeNode {
    if (!n.children || n.children.length === 0) return n;
    n.children = n.children.map(prune).filter(c => (c.value ?? 0) > 0 || (c.children?.length ?? 0) > 0);
    if (n.children.length === 0) delete n.children;
    return n;
  }

  return prune(root);
}

// ── Color palettes ────────────────────────────────────────────────────────
interface PaletteRange { light: string; dark: string; }
const PALETTES: Record<string, PaletteRange> = {
  Slate:  { light: '#d0d0ce', dark: '#232321' },
  Ocean:  { light: '#a8d8ea', dark: '#0d2d4a' },
  Forest: { light: '#b8ddb0', dark: '#1a3d14' },
  Dusk:   { light: '#d8b8e8', dark: '#280d40' },
  Ember:  { light: '#f0d090', dark: '#5a0a02' },
};

// ── Example CSV ───────────────────────────────────────────────────────────
const EXAMPLE_CSV = `category,subcategory,revenue
Technology,Software,4200000
Technology,Hardware,2900000
Healthcare,Devices,3800000
Healthcare,Pharma,5100000
Finance,Banking,3600000
Finance,Insurance,1700000
Retail,Apparel,2100000
Retail,Electronics,4700000
Energy,Renewables,3400000
Energy,Oil & Gas,6800000`;

// ── Format helpers ─────────────────────────────────────────────────────────
function fmt(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(v % 1 === 0 ? 0 : 2);
}

// ── Treemap Component ──────────────────────────────────────────────────────
interface TreemapProps {
  data: TreeNode;
  valueCol: string;
  allCols: string[];
  palette: PaletteRange;
  onDrill: (name: string) => void;
}

interface TreemapHandle {
  exportPng: (opts?: { width?: number; height?: number }) => void;
  getSize: () => { width: number; height: number };
}

const TreemapViz = forwardRef<TreemapHandle, TreemapProps>(
function TreemapViz({ data, valueCol, allCols, palette, onDrill }, ref) {
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    const tip = tooltipRef.current;
    if (!svg || !container || !tip) return;

    const W = container.clientWidth;
    const H = container.clientHeight;

    const hierarchy = d3.hierarchy<TreeNode>(data)
      .sum(d => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    // Value-based sequential color scale: larger value = darker color
    const leaves0 = hierarchy.leaves();
    const vals = leaves0.map(d => d.value ?? 0);
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const colorScale = d3.scaleSequential(
      d3.interpolateRgb(palette.light, palette.dark)
    ).domain([minV, maxV]);

    function getColor(d: RectNode): string {
      // Walk to first ancestor with no children (leaf) to get its value
      let node: RectNode = d;
      while (node.children) node = node.children[0] as RectNode;
      return colorScale(node.value ?? minV);
    }

    const treemapLayout = d3.treemap<TreeNode>()
      .size([W, H])
      .paddingTop(d => (d.depth === 0 ? 0 : d.children ? 20 : 0))
      .paddingInner(2)
      .paddingOuter(3)
      .round(true);

    // Cast to RectNode after layout is applied
    const root = treemapLayout(hierarchy) as RectNode;

    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    d3.select(svg).selectAll('*').remove();

    const g = d3.select(svg).append('g');
    const leaves = root.leaves();
    const groups = root.descendants().filter(d => d.depth >= 1 && (d.children?.length ?? 0) > 0);

    const cw = (d: RectNode) => Math.max(0, d.x1 - d.x0);
    const ch = (d: RectNode) => Math.max(0, d.y1 - d.y0);

    // Define a clipPath for each leaf cell so text is always contained
    const defs = d3.select(svg).append('defs');
    leaves.forEach((d, i) => {
      defs.append('clipPath')
        .attr('id', `clip-${i}`)
        .append('rect')
        .attr('width', cw(d))
        .attr('height', ch(d));
    });

    // Leaf cells
    const cellG = g.selectAll<SVGGElement, RectNode>('g.cell')
      .data(leaves)
      .join('g')
      .attr('class', 'cell')
      .attr('transform', d => `translate(${d.x0},${d.y0})`)
      .attr('clip-path', (_d, i) => `url(#clip-${i})`)
      .style('cursor', 'default');

    cellG.append('rect')
      .attr('width', d => cw(d))
      .attr('height', d => ch(d))
      .attr('rx', 3)
      .attr('fill', d => {
        const c = d3.color(getColor(d))!;
        return d.depth > 2 ? (c.brighter(0.4 * (d.depth - 2)) as d3.RGBColor).formatHex() : c.formatHex();
      })
      .attr('stroke', 'rgba(255,255,255,0.15)')
      .attr('stroke-width', 0.5);

    cellG.each(function (d) {
      const w = cw(d), h = ch(d);
      if (w < 28 || h < 18) return;
      const sel = d3.select(this);
      const bright = d3.hsl(getColor(d)).l > 0.5;
      const textColor = bright ? 'rgba(0,0,0,0.82)' : 'rgba(255,255,255,0.92)';
      const subColor  = bright ? 'rgba(0,0,0,0.52)' : 'rgba(255,255,255,0.58)';

      const name = d.data.name;
      const valStr = fmt(d.value ?? 0);
      const pad = 8;
      const usableW = w - pad * 2;

      // Compute font size: fill the width based on character count,
      // then cap by a fraction of cell height so it never overflows.
      const charWidth = 0.55; // avg char width as fraction of font-size (Inter)
      const showValue = h >= 52 && w >= 44;
      const lines = showValue ? 2 : 1;

      // Start from width-filling size, then cap to keep text inside the cell
      let fs = Math.min(
        usableW / (name.length * charWidth),   // fill width
        (h - 12) / (lines * 1.55),             // fit all lines + padding vertically
        Math.max(usableW / 6, 11),             // min readable
        56                                     // absolute cap
      );
      fs = Math.max(fs, 9);

      // Center vertically
      const lineH    = fs * 1.25;
      const totalH   = showValue ? lineH + fs * 0.85 + 4 : lineH;
      const topY     = (h - totalH) / 2 + lineH * 0.82;

      // Clamp name to fit
      const maxChars = Math.max(1, Math.floor(usableW / (fs * charWidth)));
      const label = name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name;

      sel.append('text')
        .attr('x', w / 2).attr('y', topY)
        .attr('text-anchor', 'middle')
        .attr('fill', textColor)
        .attr('font-size', fs)
        .attr('font-weight', '700')
        .attr('font-family', 'Inter, system-ui, sans-serif')
        .attr('letter-spacing', fs > 20 ? '-0.02em' : '0')
        .text(label);

      if (showValue) {
        const vfs = Math.max(fs * 0.62, 9);
        sel.append('text')
          .attr('x', w / 2).attr('y', topY + lineH * 0.75 + vfs * 0.9)
          .attr('text-anchor', 'middle')
          .attr('fill', subColor)
          .attr('font-size', vfs)
          .attr('font-weight', '500')
          .attr('font-family', 'Inter, system-ui, sans-serif')
          .text(valStr);
      }
    });

    // Group headers — large, bold, upper-area label
    groups.forEach(g2 => {
      const gw = g2.x1 - g2.x0;
      const gh = g2.y1 - g2.y0;
      if (gw < 40 || gh < 16) return;
      const name = g2.data.name;
      const fs = Math.min(13, gw / (name.length * 0.6 + 2));
      const maxChars = Math.max(1, Math.floor((gw - 16) / (fs * 0.6)));
      const label = name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name;
      d3.select(svg).append('text')
        .attr('x', g2.x0 + 8).attr('y', g2.y0 + fs + 2)
        .attr('fill', '#1a1a18').attr('font-size', fs).attr('font-weight', '700')
        .attr('font-family', 'Inter, system-ui, sans-serif').attr('opacity', 0.75)
        .text(label);
    });


    // Drillable group overlay (depth-1 groups)
    const groupCells = g.selectAll<SVGGElement, RectNode>('g.group-overlay')
      .data(groups.filter(d => d.depth === 1))
      .join('g')
      .attr('class', 'group-overlay')
      .attr('transform', d => `translate(${d.x0},${d.y0})`)
      .style('cursor', 'pointer');

    groupCells.append('rect')
      .attr('width', d => Math.max(0, d.x1 - d.x0))
      .attr('height', 18)
      .attr('fill', 'transparent');

    groupCells.on('click', (_, d) => onDrill(d.data.name));

    // Tooltip
    cellG
      .on('mousemove', (event, d) => {
        const row = d.data.row ?? {};
        const extraCols = allCols.filter(c => c !== valueCol);
        tip.innerHTML = `
          <div class="tooltip-name">${d.data.name}</div>
          <div class="tooltip-path">${d.ancestors().map(a => a.data.name).reverse().slice(1).join(' › ')}</div>
          <div class="tooltip-rows">
            <div class="tooltip-row"><span class="tooltip-key">${valueCol}</span><span class="tooltip-val">${fmt(d.value ?? 0)}</span></div>
            ${extraCols.slice(0, 6).map(c => `<div class="tooltip-row"><span class="tooltip-key">${c}</span><span class="tooltip-val">${row[c] ?? '—'}</span></div>`).join('')}
          </div>`;
        tip.classList.add('visible');
        tip.style.left = `${event.clientX + 14}px`;
        tip.style.top = `${event.clientY - 10}px`;
      })
      .on('mouseleave', () => tip.classList.remove('visible'));

    return () => { d3.select(svg).selectAll('*').remove(); };
  }, [data, valueCol, allCols, onDrill, palette]);

  useImperativeHandle(ref, () => ({
    getSize() {
      const c = containerRef.current;
      return { width: c?.clientWidth ?? 1200, height: c?.clientHeight ?? 800 };
    },
    exportPng({ width, height }: { width?: number; height?: number } = {}) {
      const svg = svgRef.current;
      const container = containerRef.current;
      if (!svg || !container) return;
      const srcW = container.clientWidth;
      const srcH = container.clientHeight;
      const W = width ?? srcW;
      const H = height ?? srcH;

      // Scale SVG viewBox from source to target dimensions
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('viewBox', `0 0 ${srcW} ${srcH}`);
      clone.setAttribute('width', String(W));
      clone.setAttribute('height', String(H));
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('width', String(srcW));
      bg.setAttribute('height', String(srcH));
      bg.setAttribute('fill', '#f8f8f7');
      clone.insertBefore(bg, clone.firstChild);

      const svgStr = new XMLSerializer().serializeToString(clone);
      const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 2;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        const ctx = canvas.getContext('2d')!;
        ctx.scale(dpr, dpr);
        ctx.drawImage(img, 0, 0, W, H);
        URL.revokeObjectURL(url);
        const a = document.createElement('a');
        a.download = `treemap-${W}x${H}.png`;
        a.href = canvas.toDataURL('image/png');
        a.click();
      };
      img.src = url;
    },
  }), []);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <svg ref={svgRef} style={{ display: 'block' }} />
      <div ref={tooltipRef} className="treemap-tooltip" />
    </div>
  );
});


// ── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  const [rows, setRows] = useState<Row[]>([]);
  const [cols, setCols] = useState<string[]>([]);
  const [numCols, setNumCols] = useState<string[]>([]);
  const [strCols, setStrCols] = useState<string[]>([]);
  const [valueCol, setValueCol] = useState('');
  const [groupCol, setGroupCol] = useState('');
  const [filename, setFilename] = useState('');
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
  const [pasteText, setPasteText] = useState('');
  const [panelWidth, setPanelWidth] = useState(420);
  const [paletteKey, setPaletteKey] = useState<string>('Slate');
  const [aspectRatio, setAspectRatio] = useState<number | null>(1); // 1, 16/9, 4/3, null
  const [isCustomRatio, setIsCustomRatio] = useState(false);
  const [customRatio, setCustomRatio] = useState({ w: 16, h: 9 });
  const [exportOpen, setExportOpen] = useState(false);
  const [exportW, setExportW] = useState(1080);
  const [exportH, setExportH] = useState(1080);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const treemapRef = useRef<TreemapHandle>(null);
  const rightPanelRef = useRef<HTMLElement>(null);
  const [rightPanelSize, setRightPanelSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = rightPanelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setRightPanelSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let viewW = rightPanelSize.w;
  let viewH = rightPanelSize.h;
  if (aspectRatio && rightPanelSize.w > 0 && rightPanelSize.h > 0) {
    const pad = 40; // breathing room around the live canvas
    const availW = Math.max(1, rightPanelSize.w - pad);
    const availH = Math.max(1, rightPanelSize.h - pad);
    if (availW / availH > aspectRatio) {
      viewH = availH;
      viewW = availH * aspectRatio;
    } else {
      viewW = availW;
      viewH = availW / aspectRatio;
    }
  }

  const openExportPopover = useCallback(() => {
    let ew = 1080, eh = 1080;
    if (aspectRatio === null) {
      const size = treemapRef.current?.getSize();
      if (size) { ew = size.width; eh = size.height; }
    } else if (Math.abs(aspectRatio - 16/9) < 0.01) {
      ew = 1920; eh = 1080;
    } else if (Math.abs(aspectRatio - 4/3) < 0.01) {
      ew = 1200; eh = 900;
    }
    setExportW(Math.round(ew));
    setExportH(Math.round(eh));
    setExportOpen(true);
  }, [aspectRatio]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(260, Math.min(700, startW + ev.clientX - startX));
      setPanelWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [panelWidth]);

  const loadCSVText = useCallback((text: string, name = '') => {
    const parsed = parseCSV(text);
    if (parsed.length === 0) { setError('Could not parse CSV — check the format.'); return; }
    setError('');
    const allCols = Object.keys(parsed[0]);
    const numeric = allCols.filter(c => parsed.slice(0, 50).some(r => typeof r[c] === 'number'));
    const strings = allCols.filter(c => !numeric.includes(c));
    setCols(allCols);
    setNumCols(numeric);
    setStrCols(strings);
    setValueCol(numeric[0] ?? '');
    setGroupCol(strings[0] ?? allCols[0]);
    setRows(parsed);
    setBreadcrumb([]);
    setFilename(name);
  }, []);

  const loadFile = useCallback((file: File) => {
    if (!file.name.endsWith('.csv')) { setError('Please upload a CSV file.'); return; }
    const reader = new FileReader();
    reader.onload = e => loadCSVText(e.target?.result as string, file.name);
    reader.readAsText(file);
  }, [loadCSVText]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  }, [loadFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
  }, [loadFile]);

  const treeData: TreeNode | null = (() => {
    if (!rows.length || !valueCol || !groupCol) return null;
    const full = buildHierarchy(rows, [groupCol], valueCol);
    if (breadcrumb.length === 0) return full;
    const filtered = rows.filter(r => String(r[groupCol]) === breadcrumb[0]);
    if (filtered.length === 0) return full;
    const secondGroup = strCols.find(c => c !== groupCol);
    if (secondGroup) return buildHierarchy(filtered, [secondGroup], valueCol);
    return buildHierarchy(filtered, [groupCol], valueCol);
  })();

  const handleDrill = useCallback((name: string) => {
    setBreadcrumb(prev => [...prev, name]);
  }, []);

  const handleBreadcrumbNav = useCallback((idx: number) => {
    setBreadcrumb(prev => prev.slice(0, idx));
  }, []);

  const hasData = rows.length > 0 && treeData;



  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <span className="header-logo">Treemap</span>
        {hasData && breadcrumb.length > 0 && (
          <>
            <div className="header-sep" />
            <div className="breadcrumb-inline">
              <span className="breadcrumb-item" onClick={() => setBreadcrumb([])}>All</span>
              {breadcrumb.map((seg, i) => (
                <span key={i} style={{ display: 'contents' }}>
                  <span className="breadcrumb-sep">›</span>
                  {i === breadcrumb.length - 1
                    ? <span className="breadcrumb-current">{seg}</span>
                    : <span className="breadcrumb-item" onClick={() => handleBreadcrumbNav(i + 1)}>{seg}</span>}
                </span>
              ))}
            </div>
          </>
        )}
        {hasData && (
          <div className="header-right">
            {breadcrumb.length > 0 && (
              <button className="btn-ghost" onClick={() => setBreadcrumb([])}>Reset view</button>
            )}
            <div className="export-wrap">
              <button className="btn-ghost" onClick={openExportPopover}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1v6M4 5l2 2 2-2M1 9v1.5A.5.5 0 001.5 11h9a.5.5 0 00.5-.5V9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Export PNG
              </button>
              {exportOpen && (
                <>
                  <div className="export-backdrop" onClick={() => setExportOpen(false)} />
                  <div className="export-popover">
                    <div className="export-popover-title">Export Size</div>
                    <div className="export-size-row">
                      <div className="export-field">
                        <label className="export-field-label">Width</label>
                        <input
                          className="export-field-input"
                          type="number" min={100} max={8000} step={10}
                          value={exportW}
                          onChange={e => setExportW(Number(e.target.value))}
                        />
                      </div>
                      <span className="export-x">×</span>
                      <div className="export-field">
                        <label className="export-field-label">Height</label>
                        <input
                          className="export-field-input"
                          type="number" min={100} max={8000} step={10}
                          value={exportH}
                          onChange={e => setExportH(Number(e.target.value))}
                        />
                      </div>
                      <span className="export-px">px</span>
                    </div>
                    {aspectRatio && (
                      <div className="export-presets">
                        <button className="export-preset" onClick={() => {
                          setExportH(Math.round(exportW / aspectRatio));
                        }}>
                          Constrain to view shape
                        </button>
                      </div>
                    )}
                    <button
                      className="btn-upload export-download"
                      onClick={() => {
                        treemapRef.current?.exportPng({ width: exportW, height: exportH });
                        setExportOpen(false);
                      }}
                    >
                      Download
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </header>

      {/* Body: left panel + resize handle + right panel */}
      <div className="body">
        {/* Left panel — always visible */}
        <aside className="left-panel" style={{ width: panelWidth }}>
          {error && <div className="panel-error">{error}</div>}

          <div className="panel-section">
            <div className="paste-inline-header">
              <span className="paste-inline-label">CSV</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button className="btn-ghost btn-xs" onClick={() => { setPasteText(''); setRows([]); setFilename(''); setError(''); }}>Clear</button>
                <button className="btn-ghost btn-xs" onClick={() => fileInputRef.current?.click()}>Upload</button>
                <button className="btn-ghost btn-xs" onClick={() => setPasteText(EXAMPLE_CSV)}>Example</button>
              </div>
            </div>
            <textarea
              className="panel-textarea"
              placeholder={`column1,column2,value\nA,X,100\nA,Y,200\nB,X,150`}
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              spellCheck={false}
            />
            <div
              className={`drop-zone${dragOver ? ' drag-over' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <svg className="drop-icon" width="20" height="20" viewBox="0 0 32 32" fill="none">
                <rect x="4" y="4" width="24" height="24" rx="4" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M16 10v12M11 15l5-5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="drop-title">{filename || 'Drop CSV or click to upload'}</span>
            </div>
            <input ref={fileInputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={handleFileInput} />
            <div className="panel-footer">
              <span className="paste-hint">
                {pasteText.trim() ? `${pasteText.trim().split('\n').length} lines` : ''}
              </span>
              <button
                className="btn-upload"
                disabled={!pasteText.trim() && !hasData}
                onClick={() => { if (pasteText.trim()) loadCSVText(pasteText); }}
              >
                Visualize
              </button>
            </div>
          </div>

          {hasData && (
            <div className="panel-section panel-controls">
              <div className="field-group">
                <span className="field-label">Palette</span>
                <div className="palette-swatches">
                  {Object.entries(PALETTES).map(([name, pal]) => {
                    const stops = [0, 0.25, 0.5, 0.75, 1].map(t =>
                      d3.interpolateRgb(pal.light, pal.dark)(t)
                    );
                    return (
                      <div
                        key={name}
                        className={`palette-swatch${paletteKey === name ? ' active' : ''}`}
                        title={name}
                        onClick={() => setPaletteKey(name)}
                      >
                        {stops.map((c, i) => <span key={i} style={{ background: c }} />)}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="field-group">
                <span className="field-label">Aspect ratio</span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {[
                    [1, 'Square'],
                    [16/9, '16:9'],
                    [4/3, '4:3'],
                    [null, 'Fluid'],
                    ['custom', 'Custom']
                  ].map(([val, label]) => {
                    const isActive = val === 'custom' ? isCustomRatio : (!isCustomRatio && aspectRatio === val);
                    return (
                      <button
                        key={label as string}
                        className={`btn-ghost btn-xs${isActive ? ' active' : ''}`}
                        style={Object.assign({ flex: 1, minWidth: '40px', justifyContent: 'center' }, isActive ? { background: 'var(--border)', color: 'var(--text-primary)' } : {})}
                        onClick={() => {
                          if (val === 'custom') {
                            setIsCustomRatio(true);
                            setAspectRatio(customRatio.w / customRatio.h);
                          } else {
                            setIsCustomRatio(false);
                            setAspectRatio(val as number | null);
                          }
                        }}
                      >
                        {label as React.ReactNode}
                      </button>
                    );
                  })}
                </div>
                {isCustomRatio && (
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <input
                      type="number" className="field-select" style={{ width: '60px', padding: '2px 6px' }}
                      value={customRatio.w}
                      onChange={e => {
                        const w = Math.max(1, Number(e.target.value));
                        setCustomRatio(p => ({ ...p, w }));
                        setAspectRatio(w / customRatio.h);
                      }}
                    />
                    <span style={{ color: 'var(--text-muted)' }}>:</span>
                    <input
                      type="number" className="field-select" style={{ width: '60px', padding: '2px 6px' }}
                      value={customRatio.h}
                      onChange={e => {
                        const h = Math.max(1, Number(e.target.value));
                        setCustomRatio(p => ({ ...p, h }));
                        setAspectRatio(customRatio.w / h);
                      }}
                    />
                  </div>
                )}
              </div>
              <div className="field-group row">
                <span className="field-label" style={{ width: '60px' }}>Group by</span>
                <select className="field-select" value={groupCol} onChange={e => { setGroupCol(e.target.value); setBreadcrumb([]); }}>
                  {strCols.map(c => <option key={c} value={c}>{c}</option>)}
                  {numCols.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field-group row">
                <span className="field-label" style={{ width: '60px' }}>Value</span>
                <select className="field-select" value={valueCol} onChange={e => { setValueCol(e.target.value); setBreadcrumb([]); }}>
                  {numCols.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          )}
        </aside>

        {/* Resize handle */}
        <div className="resize-handle" onMouseDown={startResize} />

        {/* Right panel — treemap or placeholder, centers fixed canvas */}
        <main
          ref={rightPanelRef}
          className="right-panel"
          style={aspectRatio ? { display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' } : undefined}
        >
          {hasData ? (
             <div style={aspectRatio ? { width: viewW, height: viewH, flexShrink: 0, position: 'relative' } : { width: '100%', height: '100%' }}>
               <TreemapViz
                 ref={treemapRef}
                 data={treeData!}
                 valueCol={valueCol}
                 allCols={cols}
                 palette={PALETTES[paletteKey]}
                 onDrill={handleDrill}
               />
             </div>
          ) : (
            <div className="treemap-placeholder">
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" opacity="0.25">
                <rect x="2" y="2" width="22" height="22" rx="3" stroke="currentColor" strokeWidth="1.5"/>
                <rect x="28" y="2" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <rect x="28" y="16" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <rect x="2" y="28" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <rect x="20" y="28" width="18" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
              <span className="placeholder-text">Paste or upload a CSV to visualize</span>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
