// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

/// 笔记库根目录：~/InkVault。文档就是磁盘上的 .md 文件，图片在 .assets/ 下。
const VAULT_DIR: &str = "InkVault";
const ASSETS_DIR: &str = ".assets";

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

fn unique_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}{:04x}", nanos, n & 0xffff)
}

fn vault_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let root = home.join(VAULT_DIR);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
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
            continue; // 跳过 .assets 与其他隐藏项
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

#[tauri::command]
fn vault_root_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(vault_root(&app)?.to_string_lossy().to_string())
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
    fs::write(&p, content).map_err(|e| e.to_string())
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
    // 不允许移动到自身子目录内
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
    if p.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&p).map_err(|e| e.to_string())
    }
}

/// 图片附件：写入 .assets/<id>.<ext>，返回 id（形如 "a1b2....png"，markdown 以 asset:<id> 引用）
#[tauri::command]
fn save_asset(app: tauri::AppHandle, ext: String, data: Vec<u8>) -> Result<String, String> {
    let root = vault_root(&app)?;
    let dir = root.join(ASSETS_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    let id = format!("{}.{}", unique_id(), ext);
    fs::write(dir.join(&id), data).map_err(|e| e.to_string())?;
    Ok(id)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            vault_root_path,
            list_tree,
            read_doc,
            write_doc,
            create_node,
            rename_node,
            move_node,
            delete_node,
            save_asset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
