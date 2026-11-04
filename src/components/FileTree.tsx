import { useState } from 'react';
import { childrenOf, isDescendant, useStore } from '../store/app';
import type { DecryptedDoc } from '../lib/types';
import { IconDoc, IconFolder, IconFolderOpen, IconFolderPlus, IconPlus, IconPencil, IconTrash, IconChevronDown, IconChevronRight } from './Icons';

type DropPos = 'into';

export function FileTree() {
  const docs = useStore((s) => s.docs);
  const createNode = useStore((s) => s.createNode);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [rootDragOver, setRootDragOver] = useState(false);
  const roots = childrenOf(docs, null);

  return (
    <aside className="filetree">
      <div className="filetree-header">
        <span className="filetree-title">文档库</span>
        <span className="filetree-actions">
          <button title="新建文档" onClick={() => void createNode(null, false)}>
            <IconPlus />
          </button>
          <button title="新建文件夹" onClick={() => void createNode(null, true)}>
            <IconFolderPlus />
          </button>
        </span>
      </div>
      <div
        className={`filetree-body${rootDragOver ? ' root-dragover' : ''}`}
        onDragOver={(e) => {
          if (!draggingId) return;
          e.preventDefault();
          setRootDragOver(true);
        }}
        onDragLeave={() => setRootDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setRootDragOver(false);
          if (draggingId) {
            void useStore.getState().moveNode(draggingId, null);
          }
          setDraggingId(null);
        }}
      >
        {roots.map((d) => (
          <TreeNode key={d.id} doc={d} depth={0} draggingId={draggingId} setDraggingId={setDraggingId} />
        ))}
        {roots.length === 0 && (
          <p className="filetree-empty">
            暂无文档
            <br />
            点上方按钮新建
          </p>
        )}
      </div>
    </aside>
  );
}

function TreeNode({
  doc,
  depth,
  draggingId,
  setDraggingId,
}: {
  doc: DecryptedDoc;
  depth: number;
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
}) {
  const docs = useStore((s) => s.docs);
  const activeId = useStore((s) => s.activeId);
  const isExpanded = useStore((s) => !!s.expanded[doc.id]);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(doc.title);
  const [dropPos, setDropPos] = useState<DropPos | null>(null);

  const { selectDoc, toggleFolder, createNode, renameNode, deleteNode, moveNode } = useStore.getState();
  const isFolder = doc.isFolder;
  const isOpen = isFolder && isExpanded;
  const children = isFolder ? childrenOf(docs, doc.id) : [];
  const active = activeId === doc.id;

  function commitRename() {
    setRenaming(false);
    const t = title.trim();
    if (t && t !== doc.title) void renameNode(doc.id, t);
  }

  function confirmDelete() {
    const label = doc.title || (isFolder ? '文件夹' : '文档');
    const hasChildren = isFolder && childrenOf(docs, doc.id).length > 0;
    const msg = hasChildren ? `删除文件夹「${label}」及其全部内容？此操作不可恢复。` : `删除「${label}」？`;
    if (window.confirm(msg)) void deleteNode(doc.id);
  }

  function handleDragOver(e: React.DragEvent) {
    if (!draggingId || draggingId === doc.id) return;
    if (isDescendant(docs, draggingId, doc.id)) return; // 不能拖进自身子树
    if (!isFolder) return; // 文档行不作为放置目标（文件按名称排序，无前后插入意义）
    e.preventDefault();
    e.stopPropagation();
    setDropPos('into');
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const id = draggingId;
    setDropPos(null);
    setDraggingId(null);
    if (!id || id === doc.id || !dropPos) return;
    void moveNode(id, doc.id);
  }

  return (
    <>
      <div
        className={`tree-row${active ? ' active' : ''}${dropPos ? ` drop-${dropPos}` : ''}${draggingId === doc.id ? ' dragging' : ''}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        draggable={!renaming}
        onDragStart={(e) => {
          setDraggingId(doc.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => setDraggingId(null)}
        onDragOver={handleDragOver}
        onDragLeave={() => setDropPos(null)}
        onDrop={handleDrop}
        onClick={() => (isFolder ? toggleFolder(doc.id) : selectDoc(doc.id))}
      >
        {isFolder ? <span className="tree-caret">{isOpen ? <IconChevronDown /> : <IconChevronRight />}</span> : <span className="tree-caret-leaf" />}
        <span className="tree-icon">{isFolder ? (isOpen ? <IconFolderOpen /> : <IconFolder />) : <IconDoc />}</span>
        {renaming ? (
          <input
            className="tree-rename"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span className="tree-label" title={doc.title}>
            {doc.title || '无标题'}
          </span>
        )}
        <span className="tree-ops" onClick={(e) => e.stopPropagation()}>
          {isFolder && (
            <>
              <button title="新建子文档" onClick={() => void createNode(doc.id, false)}>
                <IconPlus />
              </button>
              <button title="新建子文件夹" onClick={() => void createNode(doc.id, true)}>
                <IconFolderPlus />
              </button>
            </>
          )}
          <button
            title="重命名"
            onClick={() => {
              setTitle(doc.title);
              setRenaming(true);
            }}
          >
            <IconPencil />
          </button>
          <button title="删除" onClick={confirmDelete}>
            <IconTrash />
          </button>
        </span>
      </div>
      {isOpen && children.map((c) => (
        <TreeNode key={c.id} doc={c} depth={depth + 1} draggingId={draggingId} setDraggingId={setDraggingId} />
      ))}
    </>
  );
}
