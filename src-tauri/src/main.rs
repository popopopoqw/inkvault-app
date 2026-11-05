// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, RwLock};
use tauri::{Emitter, Manager};

/// 笔记库根目录：~/墨匣。文档就是磁盘上的 .md 文件，图片在 .assets/ 下。
const VAULT_DIR: &str = "墨匣";
const ASSETS_DIR: &str = ".assets";
/// 版本历史目录（增量快照链：一个 full + 若干 delta）
const HISTORY_DIR: &str = ".history";
/// 同一文档两次快照的最小间隔
const SNAPSHOT_MIN_INTERVAL_MS: u64 = 10 * 60 * 1000;
/// 版本数超过该值时收敛链头（重放生成新全文，丢弃更老的一半）
const VERSIONS_HARD_LIMIT: usize = 60;

#[derive(Serialize, Clone)]
pub struct Node {
    pub path: String,
    pub name: String,
    pub is_folder: bool,
}

#[derive(Serialize)]
pub struct PathChange {
    pub old_path: String,
    pub new_path: String,
}

#[derive(Serialize, Clone)]
pub struct VersionInfo {
    pub seq: u64,
    pub time_ms: u64,
    pub added: u64,
    pub removed: u64,
    pub is_full: bool,
}

#[derive(Serialize)]
pub struct OpenResult {
    pub root: String,
    pub select_path: Option<String>,
}

fn unique_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}{:04x}", nanos, n & 0xffff)
}

static ROOT: RwLock<Option<PathBuf>> = RwLock::new(None);

// ---- 外部文件变化监听 ----
static WATCH_GEN: AtomicU64 = AtomicU64::new(0);
static WATCHED: RwLock<Option<(u64, PathBuf)>> = RwLock::new(None);
static SELF_WRITES: LazyLock<RwLock<std::collections::HashMap<PathBuf, std::time::Instant>>> =
    LazyLock::new(|| RwLock::new(std::collections::HashMap::new()));

/// 记录「应用自己写过的路径 + 时间」，监听线程据此过滤自身触发的文件事件
fn note_self_write(path: &Path) {
    if let Ok(mut w) = SELF_WRITES.write() {
        let now = std::time::Instant::now();
        w.retain(|_, t| now.duration_since(*t) < std::time::Duration::from_secs(3));
        w.insert(path.to_path_buf(), now);
    }
}

fn is_all_self_writes(paths: &[PathBuf]) -> bool {
    if paths.is_empty() {
        return false;
    }
    if let Ok(w) = SELF_WRITES.read() {
        let now = std::time::Instant::now();
        return paths.iter().all(|p| {
            w.get(p).map(|t| now.duration_since(*t) < std::time::Duration::from_secs(3)).unwrap_or(false)
        });
    }
    false
}

/// 递归监听笔记库根目录，外部变化通过 `fs-change` 事件推给前端；重复调用自动换根
fn ensure_watch(app: &tauri::AppHandle, root: &Path) {
    if let Some(guard) = WATCHED.read().ok() {
        if let Some((_, r)) = &*guard {
            if r == root {
                return;
            }
        }
    }
    let gen = WATCH_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    if let Ok(mut w) = WATCHED.write() {
        *w = Some((gen, root.to_path_buf()));
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(_) => return,
    };
    if watcher.watch(root, RecursiveMode::Recursive).is_err() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let _keep_alive = watcher; // watcher 必须存活，线程结束即停止监听
        while let Ok(event) = rx.recv() {
            if WATCH_GEN.load(Ordering::Relaxed) != gen {
                break; // 已切换到新的监听目录
            }
            let Ok(event) = event else { continue };
            // .history 自身的写入不视为外部变化
            if event.paths.iter().any(|p| p.components().any(|c| c.as_os_str() == HISTORY_DIR)) {
                continue;
            }
            if event.paths.is_empty() || is_all_self_writes(&event.paths) {
                continue;
            }
            let paths: Vec<String> = event.paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
            let _ = app.emit("fs-change", paths);
        }
    });
}

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".inkvault-root"))
}

/// 笔记库根目录：优先用「打开」过的目录（记录在 ~/.inkvault-root），默认 ~/墨匣
fn vault_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(r) = ROOT.read().ok().and_then(|g| g.clone()) {
        return Ok(r);
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let saved = fs::read_to_string(config_file(app)?)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_dir());
    let root = saved.unwrap_or_else(|| home.join(VAULT_DIR));
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if let Ok(mut g) = ROOT.write() {
        *g = Some(root.clone());
    }
    ensure_watch(app, &root);
    Ok(root)
}

/// 校验路径位于笔记库内且不含 ..，防止越权读写库外文件
fn safe_path(root: &Path, input: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(input);
    if !p.starts_with(root) {
        return Err("path outside vault".into());
    }
    for comp in p.components() {
        if matches!(comp, std::path::Component::ParentDir) {
            return Err("invalid path".into());
        }
    }
    Ok(p)
}

fn valid_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > 200
        || trimmed == "."
        || trimmed == ".."
        || trimmed.starts_with('.')
        || trimmed.contains(['/', '\\', ':'])
    {
        return Err("invalid name".into());
    }
    Ok(trimmed.to_string())
}

/// 目标已存在时自动追加序号（"无标题 2.md"）
fn unique_target(dir: &Path, name: &str, is_folder: bool) -> PathBuf {
    let make = |n: usize| -> PathBuf {
        let file_name = if n == 1 {
            if is_folder { name.to_string() } else { format!("{name}.md") }
        } else if is_folder {
            format!("{name} {n}")
        } else {
            format!("{name} {n}.md")
        };
        dir.join(file_name)
    };
    let mut n = 1;
    loop {
        let target = make(n);
        if !target.exists() {
            return target;
        }
        n += 1;
    }
}

fn walk(dir: &Path, out: &mut Vec<Node>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for entry in items {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // 跳过 .assets / .history 与其他隐藏项
        }
        let path = entry.path();
        let is_folder = path.is_dir();
        if !is_folder && !name.ends_with(".md") {
            continue; // 只把 .md 当作文档，其余文件原样保留在磁盘
        }
        out.push(Node {
            path: path.to_string_lossy().to_string(),
            name,
            is_folder,
        });
        if is_folder {
            walk(&path, out);
        }
    }
}

// ---------------- 版本历史：行级 diff 快照链 ----------------

/// 行级 diff 指令（对旧文本从上往下应用）
enum DiffOp {
    Keep(usize),
    Del(Vec<String>),
    Add(Vec<String>),
}

/// 经典 LCS 行级 diff；超长文档（>4000 行）退化为「整篇替换」，避免 O(n²) 开销失控
fn line_diff(old: &[String], new: &[String]) -> Vec<DiffOp> {
    if old.len() > 4000 || new.len() > 4000 {
        return vec![DiffOp::Del(old.to_vec()), DiffOp::Add(new.to_vec())];
    }
    let n = old.len();
    let m = new.len();
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if old[i] == new[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i][j + 1].max(dp[i + 1][j])
            };
        }
    }
    let mut ops: Vec<DiffOp> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if old[i] == new[j] {
            push_op(&mut ops, DiffOp::Keep(1));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            push_op(&mut ops, DiffOp::Del(vec![old[i].clone()]));
            i += 1;
        } else {
            push_op(&mut ops, DiffOp::Add(vec![new[j].clone()]));
            j += 1;
        }
    }
    if i < n {
        push_op(&mut ops, DiffOp::Del(old[i..].to_vec()));
    }
    if j < m {
        push_op(&mut ops, DiffOp::Add(new[j..].to_vec()));
    }
    ops
}

fn push_op(ops: &mut Vec<DiffOp>, op: DiffOp) {
    // 相邻同类合并，delta 更紧凑
    match (ops.last_mut(), &op) {
        (Some(DiffOp::Keep(a)), DiffOp::Keep(b)) => *a += b,
        (Some(DiffOp::Del(a)), DiffOp::Del(b)) => a.extend_from_slice(b),
        (Some(DiffOp::Add(a)), DiffOp::Add(b)) => a.extend_from_slice(b),
        _ => ops.push(op),
    }
}

/// 序列化 delta：=n / -n / +n 后跟 n 行内容（内容行以 \1 前缀区分指令行）
fn encode_delta(ops: &[DiffOp]) -> String {
    let mut out = String::new();
    for op in ops {
        match op {
            DiffOp::Keep(n) => out.push_str(&format!("={n}\n")),
            DiffOp::Del(lines) | DiffOp::Add(lines) => {
                let sign = if matches!(op, DiffOp::Del(_)) { '-' } else { '+' };
                out.push_str(&format!("{sign}{}\n", lines.len()));
                for l in lines {
                    out.push('\u{1}');
                    out.push_str(l);
                    out.push('\n');
                }
            }
        }
    }
    out
}

fn decode_delta(text: &str) -> Result<Vec<DiffOp>, String> {
    let mut ops = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.starts_with('=') {
            ops.push(DiffOp::Keep(line[1..].parse().map_err(|_| "bad delta")?));
        } else if line.starts_with('-') || line.starts_with('+') {
            let count: usize = line[1..].parse().map_err(|_| "bad delta")?;
            let mut changed = Vec::with_capacity(count);
            for _ in 0..count {
                let l = lines.next().ok_or("bad delta")?;
                changed.push(l.strip_prefix('\u{1}').unwrap_or(l).to_string());
            }
            ops.push(if line.starts_with('-') { DiffOp::Del(changed) } else { DiffOp::Add(changed) });
        } else if line.is_empty() {
            continue;
        } else {
            return Err("bad delta".into());
        }
    }
    Ok(ops)
}

fn apply_delta(old: &[String], ops: &[DiffOp]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let mut src = 0usize;
    for op in ops {
        match op {
            DiffOp::Keep(n) => {
                if src + n > old.len() {
                    return Err("delta mismatch".into());
                }
                out.extend(old[src..src + n].iter().cloned());
                src += n;
            }
            DiffOp::Del(lines) => {
                let n = lines.len();
                if src + n > old.len() {
                    return Err("delta mismatch".into());
                }
                src += n;
            }
            DiffOp::Add(lines) => out.extend(lines.iter().cloned()),
        }
    }
    if src != old.len() {
        return Err("delta mismatch".into());
    }
    Ok(out)
}

/// 相对路径转义（分隔符 → __），用于历史目录命名
fn escape_rel(root: &Path, doc: &Path) -> String {
    let rel = doc.strip_prefix(root).unwrap_or(doc);
    rel.to_string_lossy().replace(['/', '\\', std::path::MAIN_SEPARATOR], "__")
}

/// 历史目录：.history/<文档相对路径，分隔符替换为 __>/
fn history_dir(root: &Path, doc: &Path) -> PathBuf {
    root.join(HISTORY_DIR).join(escape_rel(root, doc))
}

/// 删除文档（或文件夹）时清理历史：自身 + 文件夹内所有子孙文档的快照目录
fn remove_history_for(root: &Path, p: &Path) {
    let hist_root = root.join(HISTORY_DIR);
    let _ = fs::remove_dir_all(hist_root.join(escape_rel(root, p)));
    let prefix = format!("{}__", escape_rel(root, p));
    if let Ok(rd) = fs::read_dir(&hist_root) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
}

/// 改名/移动时历史目录跟随：自身 + 文件夹内所有子孙文档的快照目录前缀替换
fn remap_history_dir(root: &Path, old: &Path, new: &Path) {
    let hist_root = root.join(HISTORY_DIR);
    let old_esc = escape_rel(root, old);
    let new_esc = escape_rel(root, new);
    let h_old = hist_root.join(&old_esc);
    if h_old.exists() {
        let _ = fs::rename(&h_old, hist_root.join(&new_esc));
    }
    let prefix = format!("{old_esc}__");
    if let Ok(rd) = fs::read_dir(&hist_root) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(rest) = name.strip_prefix(&prefix) {
                let _ = fs::rename(e.path(), hist_root.join(format!("{new_esc}__{rest}")));
            }
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 读取版本索引（按文件名排序 = seq 升序），从目录扫描重建
fn read_versions(dir: &Path) -> Vec<VersionInfo> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    files.sort();
    let mut out = Vec::new();
    for f in files {
        let name = f.file_name().unwrap_or_default().to_string_lossy().to_string();
        let Some((seq, time_ms)) = parse_version_name(&name) else { continue };
        let is_full = name.ends_with(".full");
        let (added, removed) = if is_full {
            (0, 0)
        } else {
            fs::read_to_string(&f)
                .ok()
                .and_then(|t| decode_delta(&t).ok())
                .map(|ops| count_ops(&ops))
                .unwrap_or((0, 0))
        };
        out.push(VersionInfo { seq, time_ms, added, removed, is_full });
    }
    out
}

fn parse_version_name(name: &str) -> Option<(u64, u64)> {
    let stem = name.trim_end_matches(".delta").trim_end_matches(".full");
    let mut parts = stem.splitn(2, '-');
    let seq = parts.next()?.parse().ok()?;
    let time = parts.next()?.parse().ok()?;
    Some((seq, time))
}

fn count_ops(ops: &[DiffOp]) -> (u64, u64) {
    let mut added = 0u64;
    let mut removed = 0u64;
    for op in ops {
        match op {
            DiffOp::Keep(_) => {}
            DiffOp::Del(lines) => removed += lines.len() as u64,
            DiffOp::Add(lines) => added += lines.len() as u64,
        }
    }
    (added, removed)
}

fn version_file_name(v: &VersionInfo) -> String {
    if v.is_full {
        format!("{}-{}.full", v.seq, v.time_ms)
    } else {
        format!("{}-{}.delta", v.seq, v.time_ms)
    }
}

static LAST_SNAPSHOT: LazyLock<RwLock<std::collections::HashMap<PathBuf, u64>>> =
    LazyLock::new(|| RwLock::new(std::collections::HashMap::new()));

/// 写盘后调用：把「旧内容 → 新内容」的变化存为增量快照。
/// force = true 时无视间隔（恢复版本前强制存档用）。
fn maybe_snapshot(root: &Path, doc: &Path, old_content: Option<&str>, new_content: &str, force: bool) {
    let dir = history_dir(root, doc);
    let versions = read_versions(&dir);
    if !versions.is_empty() && !force {
        if let Ok(m) = LAST_SNAPSHOT.read() {
            if let Some(t) = m.get(doc) {
                if now_ms().saturating_sub(*t) < SNAPSHOT_MIN_INTERVAL_MS {
                    return; // 距上次快照太近，跳过（中间版本被覆盖是衰减策略的预期）
                }
            }
        }
    }
    let _ = fs::create_dir_all(&dir);
    let time = now_ms();
    let next_seq = versions.last().map(|v| v.seq + 1).unwrap_or(0);
    if versions.is_empty() {
        // 首版：写盘前的旧内容存全文（新文件则为空），随后是到新内容的 delta
        let full_name = format!("{next_seq}-{time}.full");
        let full_path = dir.join(&full_name);
        let _ = fs::write(&full_path, old_content.unwrap_or(""));
        note_self_write(&full_path);
    }
    let delta_seq = if versions.is_empty() { next_seq + 1 } else { next_seq };
    let old_lines: Vec<String> = old_content.unwrap_or("").lines().map(|s| s.to_string()).collect();
    let new_lines: Vec<String> = new_content.lines().map(|s| s.to_string()).collect();
    let delta_name = format!("{delta_seq}-{time}.delta");
    let delta_path = dir.join(&delta_name);
    let _ = fs::write(&delta_path, encode_delta(&line_diff(&old_lines, &new_lines)));
    note_self_write(&delta_path);
    if let Ok(mut m) = LAST_SNAPSHOT.write() {
        m.insert(doc.to_path_buf(), time);
    }
    compact_history(&dir, &versions);
}

/// 版本数超限时收敛：把最老一半重放成新的全文链头，丢弃更老的 delta（链保持可重放）
fn compact_history(dir: &Path, versions: &[VersionInfo]) {
    if versions.len() < VERSIONS_HARD_LIMIT {
        return;
    }
    let cut = versions.len() / 2;
    let Some(content) = reconstruct(dir, &versions[..=cut]) else { return };
    let pivot = &versions[cut];
    let new_full = dir.join(format!("{}-{}.full", pivot.seq, now_ms()));
    if fs::write(&new_full, content).is_ok() {
        note_self_write(&new_full);
        for v in &versions[..cut] {
            let _ = fs::remove_file(dir.join(version_file_name(v)));
        }
    }
}

/// 重放版本链到指定版本，返回该版本的全文
fn reconstruct(dir: &Path, versions: &[VersionInfo]) -> Option<String> {
    let mut text: Vec<String> = Vec::new();
    let mut started = false;
    for v in versions {
        let raw = fs::read_to_string(dir.join(version_file_name(v))).ok()?;
        if v.is_full {
            text = raw.lines().map(|s| s.to_string()).collect();
            started = true;
        } else if started {
            let ops = decode_delta(&raw).ok()?;
            text = apply_delta(&text, &ops).ok()?;
        } else {
            return None; // 链头必须是全文
        }
    }
    Some(text.join("\n"))
}

#[tauri::command]
fn vault_root_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(vault_root(&app)?.to_string_lossy().to_string())
}

/// 打开本地文件夹（作为笔记库根）或单个 Markdown 文件（以其所在文件夹为根并选中它）
#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<OpenResult, String> {
    let p = PathBuf::from(&path);
    let (root, select) = if p.is_dir() {
        (p, None)
    } else if p.is_file() {
        // 只接受 Markdown 文件（.md / .markdown）
        let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
        if !matches!(ext.as_deref(), Some("md") | Some("markdown")) {
            return Err("只支持打开 Markdown（.md）文件".into());
        }
        let parent = p.parent().ok_or("no parent")?.to_path_buf();
        (parent, Some(p))
    } else {
        return Err("路径不存在".into());
    };
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let _ = fs::create_dir_all(root.join(ASSETS_DIR));
    fs::write(config_file(&app)?, root.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    if let Ok(mut g) = ROOT.write() {
        *g = Some(root.clone());
    }
    ensure_watch(&app, &root);
    Ok(OpenResult {
        root: root.to_string_lossy().to_string(),
        select_path: select.map(|p| p.to_string_lossy().to_string()),
    })
}

#[tauri::command]
fn list_tree(app: tauri::AppHandle) -> Result<Vec<Node>, String> {
    let root = vault_root(&app)?;
    let mut out = Vec::new();
    walk(&root, &mut out);
    Ok(out)
}

#[tauri::command]
fn read_doc(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let root = vault_root(&app)?;
    let p = safe_path(&root, &path)?;
    fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_doc(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    let root = vault_root(&app)?;
    let p = safe_path(&root, &path)?;
    let old = fs::read_to_string(&p).ok();
    let r = fs::write(&p, &content).map_err(|e| e.to_string());
    if r.is_ok() {
        note_self_write(&p);
        maybe_snapshot(&root, &p, old.as_deref(), &content, false);
    }
    r
}

#[tauri::command]
fn create_node(
    app: tauri::AppHandle,
    parent: Option<String>,
    name: String,
    is_folder: bool,
) -> Result<Node, String> {
    let root = vault_root(&app)?;
    let dir = match &parent {
        Some(p) => {
            let d = safe_path(&root, p)?;
            if !d.is_dir() {
                return Err("parent is not a folder".into());
            }
            d
        }
        None => root,
    };
    let name = valid_name(&name)?;
    let target = unique_target(&dir, &name, is_folder);
    if is_folder {
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    } else {
        fs::write(&target, "").map_err(|e| e.to_string())?;
    }
    note_self_write(&target);
    Ok(Node {
        path: target.to_string_lossy().to_string(),
        name: target.file_name().unwrap_or_default().to_string_lossy().to_string(),
        is_folder,
    })
}

#[tauri::command]
fn rename_node(app: tauri::AppHandle, path: String, new_name: String) -> Result<PathChange, String> {
    let root = vault_root(&app)?;
    let old = safe_path(&root, &path)?;
    if !old.exists() {
        return Err("not found".into());
    }
    let new_name = valid_name(&new_name)?;
    let is_folder = old.is_dir();
    // unique_target 负责拼 .md 扩展，这里只传基础名
    let target = old.parent().map(|d| unique_target(d, &new_name, is_folder)).ok_or("no parent")?;
    if target != old {
        fs::rename(&old, &target).map_err(|e| e.to_string())?;
    }
    note_self_write(&old);
    note_self_write(&target);
    // 历史目录跟着改名（含文件夹内子文档的快照目录）
    remap_history_dir(&root, &old, &target);
    Ok(PathChange {
        old_path: old.to_string_lossy().to_string(),
        new_path: target.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn move_node(app: tauri::AppHandle, path: String, new_parent: Option<String>) -> Result<PathChange, String> {
    let root = vault_root(&app)?;
    let old = safe_path(&root, &path)?;
    if !old.exists() {
        return Err("not found".into());
    }
    if let Some(p) = &new_parent {
        let parent = safe_path(&root, p)?;
        if parent.starts_with(&old) {
            return Err("cannot move into itself".into());
        }
    }
    let dir = match &new_parent {
        Some(p) => safe_path(&root, p)?,
        None => root.clone(),
    };
    let stem = old.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let target = unique_target(&dir, &stem, old.is_dir());
    fs::rename(&old, &target).map_err(|e| e.to_string())?;
    note_self_write(&old);
    note_self_write(&target);
    remap_history_dir(&root, &old, &target);
    Ok(PathChange {
        old_path: old.to_string_lossy().to_string(),
        new_path: target.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn delete_node(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root = vault_root(&app)?;
    let p = safe_path(&root, &path)?;
    if p == root {
        return Err("cannot delete vault root".into());
    }
    if !p.exists() {
        return Ok(());
    }
    let r = if p.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&p).map_err(|e| e.to_string())
    };
    if r.is_ok() {
        note_self_write(&p);
        // 历史一并清理（含文件夹内所有子文档的快照）
        remove_history_for(&root, &p);
    }
    r
}

/// 图片附件：写入 .assets/<id>.<ext>，返回 asset 引用 id
#[tauri::command]
fn save_asset(app: tauri::AppHandle, ext: String, data: Vec<u8>) -> Result<String, String> {
    let root = vault_root(&app)?;
    let dir = root.join(ASSETS_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    let id = format!("{}.{}", unique_id(), ext);
    let target = dir.join(&id);
    fs::write(&target, data).map_err(|e| e.to_string())?;
    note_self_write(&target);
    Ok(id)
}

// ---------------- 全库搜索 ----------------

#[derive(Serialize, Clone)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub line_no: u32,
    pub line_text: String,
}

/// 跨所有 .md 文档搜索（默认忽略大小写），返回命中行（每行一条，用于跳转定位）
#[tauri::command]
fn search_all(app: tauri::AppHandle, query: String, case_sensitive: Option<bool>) -> Result<Vec<SearchHit>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let cs = case_sensitive.unwrap_or(false);
    let root = vault_root(&app)?;
    let mut out: Vec<SearchHit> = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        let mut items: Vec<_> = entries.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for e in items {
            if out.len() >= 500 {
                break;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if !name.to_lowercase().ends_with(".md") {
                continue;
            }
            let Ok(content) = fs::read_to_string(&p) else { continue };
            for (i, line) in content.lines().enumerate() {
                let hit = if cs {
                    line.contains(&q)
                } else {
                    line.to_lowercase().contains(&q.to_lowercase())
                };
                if hit {
                    let preview: String = line.trim().chars().take(80).collect();
                    out.push(SearchHit {
                        path: p.to_string_lossy().to_string(),
                        title: name.trim_end_matches(".md").trim_end_matches(".markdown").to_string(),
                        line_no: i as u32 + 1,
                        line_text: preview,
                    });
                }
            }
        }
    }
    Ok(out)
}

// ---------------- 版本历史命令 ----------------

#[derive(Serialize, Clone)]
pub struct DiffLine {
    pub kind: String, // "add" | "del"
    pub text: String,
}

#[tauri::command]
fn list_versions(app: tauri::AppHandle, path: String) -> Result<Vec<VersionInfo>, String> {
    let root = vault_root(&app)?;
    let p = safe_path(&root, &path)?;
    Ok(read_versions(&history_dir(&root, &p)))
}

/// 该版本的变更内容（增删行列表），供历史面板做 diff 视图
#[tauri::command]
fn read_version_diff(app: tauri::AppHandle, path: String, seq: u64) -> Result<Vec<DiffLine>, String> {
    let root = vault_root(&app)?;
    let p = safe_path(&root, &path)?;
    let dir = history_dir(&root, &p);
    let versions = read_versions(&dir);
    let v = versions.iter().find(|v| v.seq == seq).ok_or("version not found")?;
    let raw = fs::read_to_string(dir.join(version_file_name(v))).map_err(|e| e.to_string())?;
    let ops = decode_delta(&raw)?;
    let mut out = Vec::new();
    for op in &ops {
        match op {
            DiffOp::Add(lines) => {
                for l in lines {
                    out.push(DiffLine { kind: "add".into(), text: l.clone() });
                }
            }
            DiffOp::Del(lines) => {
                for l in lines {
                    out.push(DiffLine { kind: "del".into(), text: l.clone() });
                }
            }
            DiffOp::Keep(_) => {}
        }
    }
    Ok(out)
}

#[tauri::command]
fn read_version(app: tauri::AppHandle, path: String, seq: u64) -> Result<String, String> {
    let root = vault_root(&app)?;
    let p = safe_path(&root, &path)?;
    let dir = history_dir(&root, &p);
    let versions = read_versions(&dir);
    let idx = versions.iter().position(|v| v.seq == seq).ok_or("version not found")?;
    reconstruct(&dir, &versions[..=idx]).ok_or_else(|| "无法重建该版本".to_string())
}

/// 恢复：先把当前内容强制存为一版（恢复本身可撤销），再写入历史内容
#[tauri::command]
fn restore_version(app: tauri::AppHandle, path: String, seq: u64) -> Result<String, String> {
    let root = vault_root(&app)?;
    let p = safe_path(&root, &path)?;
    let dir = history_dir(&root, &p);
    let versions = read_versions(&dir);
    let idx = versions.iter().position(|v| v.seq == seq).ok_or("version not found")?;
    let content = reconstruct(&dir, &versions[..=idx]).ok_or_else(|| "无法重建该版本".to_string())?;
    let old = fs::read_to_string(&p).ok();
    fs::write(&p, &content).map_err(|e| e.to_string())?;
    note_self_write(&p);
    maybe_snapshot(&root, &p, old.as_deref(), &content, true);
    Ok(content)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            vault_root_path,
            open_path,
            list_tree,
            read_doc,
            write_doc,
            create_node,
            rename_node,
            move_node,
            delete_node,
            save_asset,
            search_all,
            list_versions,
            read_version_diff,
            read_version,
            restore_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
