import { useEffect, useMemo, useState } from 'react';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** 轻量日历 + 时间选择器（不引第三方库），确认后回调时间戳 */
export function DateTimePicker({
  initial,
  onConfirm,
  onCancel,
}: {
  initial: number;
  onConfirm: (ms: number) => void;
  onCancel: () => void;
}) {
  const init = new Date(initial);
  const [year, setYear] = useState(init.getFullYear());
  const [month, setMonth] = useState(init.getMonth()); // 0-based
  const [day, setDay] = useState(init.getDate());
  const [time, setTime] = useState(`${pad(init.getHours())}:${pad(init.getMinutes())}`);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // 当月日历网格（前置补齐周一起始？用周日起始，与中文习惯一致）
  const grid = useMemo(() => {
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const lead = first.getDay(); // 该月 1 号是周几（0=周日）
    const cells: (number | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [year, month]);

  const today = new Date();

  function shiftMonth(delta: number) {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    setDay(1);
  }

  function confirm() {
    const [h, m] = time.split(':').map(Number);
    const d = new Date(year, month, day, h || 0, m || 0, 0, 0);
    onConfirm(d.getTime());
  }

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dtp-card" onClick={(e) => e.stopPropagation()}>
        <div className="dtp-head">
          <button className="secondary" onClick={() => shiftMonth(-1)} title="上个月">‹</button>
          <span className="dtp-month">{year}年{month + 1}月</span>
          <button className="secondary" onClick={() => shiftMonth(1)} title="下个月">›</button>
        </div>
        <div className="dtp-grid">
          {WEEKDAYS.map((w) => (
            <span key={w} className="dtp-wd">{w}</span>
          ))}
          {grid.map((d, i) => (
            <button
              key={i}
              className={`dtp-day${d === day ? ' on' : ''}${d != null && today.getFullYear() === year && today.getMonth() === month && today.getDate() === d ? ' today' : ''}`}
              disabled={d == null}
              onClick={() => d != null && setDay(d)}
            >
              {d ?? ''}
            </button>
          ))}
        </div>
        <div className="dtp-time">
          <span>时间</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>取消</button>
          <button className="primary" onClick={confirm}>跳转</button>
        </div>
      </div>
    </div>
  );
}
