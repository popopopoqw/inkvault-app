import { useEffect, useState } from 'react';
import {
  listVersions,
  readVersion,
  readVersionDiff,
  restoreVersion,
} from '../lib/desktop';
import type { VersionInfo, DiffLine } from '../lib/desktop';
import { useStore } from '../store/app';
import { ConfirmDialog } from './ConfirmDialog';

function fmtTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '时间未知';
  const now = new Date();
  const diffMs = now.getTime() - ms;
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (diffMs < 60_000) return '刚刚';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  if (sameDay(d, now)) return `今天 ${hm}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;
  // 一周内：星期 + 时间
  if (diffMs < 6 * 86_400_000) {
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `星期${weekday} ${hm}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 完整时间戳（悬停提示用） */
function fullTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'baseline': return '基准版本';
    case 'saved': return '保存版本';
    case 'unsaved': return '未保存保护点';
    case 'restore_before': return '恢复前备份';
    case 'restore': return '恢复版本';
    case 'compaction': return '历史整理点';
    default: return '历史版本';
  }
}

/** 查看文档的变更历史：版本列表 + 变更对比 + 恢复 */
export function HistoryPanel({ docId, onClose }: { docId: string; onClose: () => void }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [selected, setSelected] = useState<VersionInfo | null>(null);
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const [fullText, setFullText] = useState<string | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const v = await listVersions(docId);
        if (!active) return;
        setLoadError(null);
        setVersions(v);
        setSelected((current) => {
          if (!current) return v[v.length - 1] ?? null;
          const updated = v.find((item) => item.seq === current.seq);
          if (!updated) return v[v.length - 1] ?? null;
          if (
            updated.time_ms === current.time_ms &&
            updated.is_full === current.is_full &&
            updated.added === current.added &&
            updated.removed === current.removed &&
            updated.kind === current.kind &&
            updated.line_count === current.line_count &&
            updated.content_bytes === current.content_bytes
          ) return current;
          return updated;
        });
      } catch (error) {
        if (active) setLoadError((error as Error)?.message ?? '读取文档历史失败');
      }
    };
    setVersions(null);
    setSelected(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [docId, refreshKey]);

  useEffect(() => {
    if (!selected) return;
    setDiff(null);
    setFullText(null);
    setShowFull(false);
    setDetailError(null);
    if (selected.is_full) return;
    void readVersionDiff(docId, selected.seq)
      .then(setDiff)
      .catch((error) => setDetailError((error as Error)?.message ?? '读取变更内容失败'));
  }, [docId, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function loadFull() {
    if (!selected) return;
    setShowFull(true);
    if (fullText === null) {
      try {
        setFullText(await readVersion(docId, selected.seq));
        setDetailError(null);
      } catch (error) {
        setDetailError((error as Error)?.message ?? '无法重建该版本');
      }
    }
  }

  async function doRestore() {
    if (!selected || busy) return;
    setConfirmRestore(false);
    setBusy(true);
    try {
      await useStore.getState().flush();
      if (useStore.getState().saveState === 'error') {
        throw new Error('当前内容保存失败，无法安全恢复');
      }
      const content = await restoreVersion(docId, selected.seq);
      useStore.getState().applyRestoredContent(docId, content);
      useStore.getState().showToast('已恢复，当前编辑内容已存入历史');
      const v = await listVersions(docId);
      setVersions(v);
      onClose();
    } catch (e) {
      useStore.getState().showToast((e as Error)?.message ?? '恢复失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="history-panel" onClick={(e) => e.stopPropagation()}>
        <div className="history-head">
          <h2>文档历史</h2>
          <div className="history-head-actions">
            <button className="secondary" onClick={() => {
              setVersions(null);
              setLoadError(null);
              setRefreshKey((key) => key + 1);
            }}>刷新</button>
            <button className="secondary" onClick={onClose}>关闭</button>
          </div>
        </div>
        {loadError && versions !== null && <p className="history-error-inline">{loadError}</p>}
        {versions === null ? (
          <p className="toc-empty">{loadError ?? '加载中…'}</p>
        ) : versions.length === 0 ? (
          <p className="toc-empty">{loadError ?? '暂无历史版本（保存后生成；未保存编辑满 10 分钟会创建保护点）'}</p>
        ) : (
          <div className="history-body">
            <div className="history-list">
              {[...versions].reverse().map((v) => (
                <div
                  key={v.seq}
                  className={`history-item${selected?.seq === v.seq ? ' active' : ''}`}
                  onClick={() => setSelected(v)}
                >
                  <span className="hi-main">
                    <span className="hi-time" title={fullTime(v.time_ms)}>#{v.seq} · {fmtTime(v.time_ms)}</span>
                    <span className="hi-stat">
                      {kindLabel(v.kind)} · {v.line_count} 行 · {fmtBytes(v.content_bytes)}
                      {!v.is_full && (
                        <> · <em className="add">+{v.added}</em> <em className="del">−{v.removed}</em></>
                      )}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <div className="history-detail">
              {selected && (
                <>
                  <div className="hd-actions">
                    <button className="secondary" onClick={() => void loadFull()}>
                      查看全文
                    </button>
                    <button className="primary" disabled={busy} onClick={() => setConfirmRestore(true)}>
                      {busy ? '恢复中…' : '恢复此版本'}
                    </button>
                  </div>
                  <div className="history-summary">
                    <strong>版本 #{selected.seq} · {kindLabel(selected.kind)}</strong>
                    <span>{fmtTime(selected.time_ms)} · {selected.line_count} 行 · {fmtBytes(selected.content_bytes)}</span>
                    {!selected.is_full && (
                      <span><em className="add">新增 {selected.added} 行</em> · <em className="del">删除 {selected.removed} 行</em></span>
                    )}
                  </div>
                  {detailError ? (
                    <p className="history-error">{detailError}</p>
                  ) : showFull ? (
                    <pre className="history-full">{fullText ?? '加载中…'}</pre>
                  ) : selected.is_full ? (
                    <p className="toc-empty">{kindLabel(selected.kind)}（保存全文），点「查看全文」看内容</p>
                  ) : diff === null ? (
                    <p className="toc-empty">加载变更…</p>
                  ) : diff.length === 0 ? (
                    <p className="toc-empty">该版本无行级变更</p>
                  ) : (
                    <div className="history-diff">
                      {diff.map((l, i) => (
                        <div key={i} className={`dl ${l.kind}`}>
                          <span className="dl-sign">{l.kind === 'add' ? '+' : '−'}</span>
                          <span className="dl-text">{l.text || '\u00a0'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        {confirmRestore && selected && (
          <ConfirmDialog
            message={`恢复到「${fmtTime(selected.time_ms)}」的版本？当前内容会先自动存入历史，可再撤销。`}
            confirmText="恢复"
            danger={false}
            onConfirm={() => void doRestore()}
            onCancel={() => setConfirmRestore(false)}
          />
        )}
      </div>
    </div>
  );
}
