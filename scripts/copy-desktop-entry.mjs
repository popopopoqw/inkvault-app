// desktop-entry.html 是零依赖静态页（Tauri 首启动填服务地址），
// 不参与 vite 构建，构建后复制进产物目录
import { copyFileSync } from 'node:fs';

copyFileSync('desktop-entry.html', 'dist/client/desktop-entry.html');
console.log('copied desktop-entry.html → dist/client/');
