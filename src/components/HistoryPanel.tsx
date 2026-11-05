import { useEffect, useState } from 'react';
import {
  listVersions,
  readVersion,
  readVersionDiff,
  restoreVersion,
} from '../lib/desktop';
import type { VersionInfo, DiffLine } from '../lib/desktop';
import { useStore } from '../store/app';

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toTimeString().slice(0, 5);
  if (sameDay) return `今天 ${hm}`;
  const yesterday = new Date(now.getTime() - 86400_000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 查看文档的变更历史：版本列表 + 变更对比 + 恢复 */
export function HistoryPanel({ docId, onClose }: { docId: string; onClose: () => void }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [selected, setSelected] = useState<VersionInfo | null>(null);
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const [fullText, setFullText] = useState<string | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listVersions(docId)
      .then((v) => {
        setVersions(v);
        if (v.length > 0) setSelected(v[v.length - 1]);
      })
      .catch(() => setVersions([]));
  }, [docId]);

  useEffect(() => {
    if (!selected) return;
    setDiff(null);
    setFullText(null);
    setShowFull(false);
    if (selected.is_full) return;
    void readVersionDiff(docId, selected.seq).then(setDiff).catch(() => setDiff([]));
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
      } catch {
        setFullText('（无法重建该版本）');
      }
    }
  }

  async function doRestore() {
    if (!selected || busy) return;
    if (!window.confirm(`恢复到「${fmtTime(selected.time_ms)}」的版本？当前内容会先自动存入历史，可再撤销。`)) return;
    setBusy(true);
    try {
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
          <button className="secondary" onClick={onClose}>
            关闭
          </button>
        </div>
        {versions === null ? (
          <p className="toc-empty">加载中…</p>
        ) : versions.length === 0 ? (
          <p className="toc-empty">暂无历史版本（编辑并保存后自动生成）</p>
        ) : (
          <div className="history-body">
            <div className="history-list">
              {[...versions].reverse().map((v) => (
                <div
                  key={v.seq}
                  className={`history-item${selected?.seq === v.seq ? ' active' : ''}`}
                  onClick={() => setSelected(v)}
                >
                  <span className="hi-time">{fmtTime(v.time_ms)}</span>
                  {v.is_full ? (
                    <span className="hi-stat">初始版本</span>
                  ) : (
                    <span className="hi-stat">
                      <em className="add">+{v.added}</em> <em className="del">−{v.removed}</em>
                    </span>
                  )}
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
                    <button className="primary" disabled={busy} onClick={() => void doRestore()}>
                      {busy ? '恢复中…' : '恢复此版本'}
                    </button>
                  </div>
                  {showFull ? (
                    <pre className="history-full">{fullText ?? '加载中…'}</pre>
                  ) : selected.is_full ? (
                    <p className="toc-empty">初始快照（保存全文），点「查看全文」看内容</p>
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
      </div>
    </div>
  );
}
