import { stepVertices, shortDate } from './results-model.js';

const palette = ['#83c652', '#e5e2e1', '#a6b595', '#899caa', '#c2b597', '#9b91ad'];
const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

export function chartGeometry(width, height, runs) {
  const mobile = width < 600;
    const plot = { left: mobile ? 58 : 94, right: width - (mobile ? 18 : 52), top: mobile ? 88 : 38, bottom: height - 74 };
  const maximum = Math.max(1, ...runs.map(run => run.actions));
  const rough = maximum / 3, magnitude = 10 ** Math.floor(Math.log10(rough));
  const unit = Math.max(1, [1, 2, 2.5, 5, 10].find(step => step * magnitude >= rough) * magnitude);
  const xMax = Math.max(unit, Math.ceil(maximum / unit) * unit);
  const x = actions => plot.left + actions / xMax * (plot.right - plot.left);
  const y = progress => plot.bottom - progress / 100 * (plot.bottom - plot.top);
  return { mobile, plot, xMax, unit, x, y };
}

export class ProgressChart {
  constructor({ canvas, labels, tooltip, onSelect }) {
    this.canvas = canvas; this.labels = labels; this.tooltip = tooltip; this.onSelect = onSelect;
    this.runs = [];
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(canvas.parentElement);
    canvas.addEventListener('pointermove', event => this.pointer(event));
    canvas.addEventListener('pointerleave', () => this.highlight(null));
    canvas.addEventListener('click', () => { if (this.active) this.onSelect(this.active.run); });
  }

  update(runs) {
    this.runs = runs;
    this.active = null;
    this.tooltip.hidden = true;
    this.labels.replaceChildren();
    runs.forEach((run, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'run-label'; button.style.color = palette[index % palette.length];
      const progress = run.points.at(-1).progress;
      button.textContent = `${shortDate(run.date)} · ${run.completion_verified ? `${run.actions.toLocaleString()} actions` : `${progress}%`}`;
      button.setAttribute('aria-label', `${run.label}, ${run.date}, ${progress}% progress, ${run.actions} submitted actions, ${run.completion_verified ? 'verified completion' : 'not completed'}. Inspect run.`);
      button.addEventListener('click', () => this.onSelect(run));
      button.addEventListener('pointerenter', () => this.highlight({ run, point: run.points.at(-1) }));
      button.addEventListener('pointerleave', () => this.highlight(null));
      button.addEventListener('focus', () => this.highlight({ run, point: run.points.at(-1) }));
      button.addEventListener('blur', () => this.highlight(null));
      this.labels.append(button);
    });
    this.draw();
  }

  draw() {
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height || !this.runs.length) return;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio);
    const ctx = this.canvas.getContext('2d'); ctx.scale(ratio, ratio);
    const geometry = chartGeometry(width, height, this.runs);
    this.geometry = geometry;
    const { mobile, plot, xMax, unit, x, y } = geometry;
    const font = getComputedStyle(this.canvas).fontFamily;
    ctx.font = `${mobile ? 13 : 18}px ${font}`;
    ctx.lineWidth = 1; ctx.strokeStyle = '#3b3e37'; ctx.fillStyle = '#e5e2e1';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    for (const progress of [0, 50, 100]) {
      const top = y(progress);
      ctx.beginPath(); ctx.moveTo(plot.left, top); ctx.lineTo(plot.right, top); ctx.stroke();
      ctx.fillText(`${progress}%`, plot.left - (mobile ? 9 : 16), top);
    }
    ctx.textAlign = 'center';
    for (let actions = 0; actions <= xMax + unit / 100; actions += unit) {
      const left = x(actions);
      if (actions > 0) {
        ctx.strokeStyle = '#282c26'; ctx.beginPath(); ctx.moveTo(left, plot.top); ctx.lineTo(left, plot.bottom); ctx.stroke();
      }
      ctx.fillText(Math.round(actions).toLocaleString(), left, plot.bottom + 25);
    }
    ctx.strokeStyle = '#b7bcb2'; ctx.beginPath(); ctx.moveTo(plot.left, plot.top); ctx.lineTo(plot.left, plot.bottom); ctx.lineTo(plot.right, plot.bottom); ctx.stroke();
    ctx.fillStyle = '#b6c0ad'; ctx.font = `${mobile ? 13 : 17}px ${font}`;
    ctx.fillText('Actions taken', (plot.left + plot.right) / 2, height - 15);
    ctx.save(); ctx.translate(mobile ? 5 : 18, (plot.top + plot.bottom) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('Game progress', 0, 0); ctx.restore();
    const labelBoxes = [];
    // Older paths first: the latest run stays visible at shared milestones.
    for (let index = this.runs.length - 1; index >= 0; index--) {
      const run = this.runs[index], color = palette[index % palette.length];
      ctx.globalAlpha = this.active && this.active.run !== run ? .25 : 1;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = index ? 2 : 2.6;
      ctx.beginPath();
      stepVertices(run).forEach((point, i) => { if (i) ctx.lineTo(x(point.actions), y(point.progress)); else ctx.moveTo(x(point.actions), y(point.progress)); });
      ctx.stroke();
      const end = { actions: run.actions, progress: run.points.at(-1).progress };
      ctx.beginPath(); ctx.arc(x(end.actions), y(end.progress), mobile ? 4.5 : 6.5, 0, Math.PI * 2); ctx.fill();
      if (this.active?.run === run) {
        const point = this.active.point;
        ctx.beginPath(); ctx.arc(x(point.actions), y(point.progress), 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#111'; ctx.lineWidth = 2; ctx.stroke();
      }
      const label = this.labels.children[index];
      if (label) {
        const box = label.getBoundingClientRect(), half = box.width / 2;
        const left = clamp(x(end.actions), half + 1, width - half - 1);
        let top = y(end.progress) - 10;
        // Stagger crowded ending labels without shrinking the plot or text.
        for (const previous of labelBoxes) {
          if (Math.abs(previous.left - left) < (previous.width + box.width) / 2 + 8
            && Math.abs(previous.top - top) < box.height + 6) top = previous.top - box.height - 6;
        }
        top = Math.max(6, top);
        label.style.left = `${left}px`; label.style.top = `${top}px`;
        label.style.opacity = this.active && this.active.run !== run ? '.45' : '1';
        labelBoxes.push({ left, top, width: box.width });
      }
    }
    ctx.globalAlpha = 1;
  }

  highlight(active) {
    this.active = active; this.tooltip.hidden = true; this.canvas.style.cursor = active ? 'pointer' : 'default'; this.draw();
  }

  pointer(event) {
    if (!this.geometry) return;
    const bounds = this.canvas.getBoundingClientRect();
    const px = event.clientX - bounds.left, py = event.clientY - bounds.top;
    const { x, y } = this.geometry;
    let nearest, distance = 21;
    for (const run of this.runs) for (const point of run.points) {
      const next = Math.hypot(x(point.actions) - px, y(point.progress) - py);
      if (next < distance) { distance = next; nearest = { run, point }; }
    }
    if (!nearest) { if (this.active) this.highlight(null); return; }
    this.active = nearest; this.canvas.style.cursor = 'pointer'; this.draw();
    const { run, point } = nearest;
    this.tooltip.textContent = `${run.label} · ${shortDate(run.date)}\n${point.progress}% verified · ${point.actions.toLocaleString()} actions\n${point.milestone ?? 'Verified milestone'}`;
    this.tooltip.hidden = false;
    const tip = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${clamp(px + 14, 0, bounds.width - tip.width)}px`;
    this.tooltip.style.top = `${clamp(py + 18, 0, bounds.height - tip.height)}px`;
  }
}
