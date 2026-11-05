import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// MOCK=1 时用内存文件系统替代 Tauri 命令，浏览器即可完整测试（不影响真实构建）
const useMock = process.env.MOCK === '1';

export default defineConfig({
  plugins: [react()],
  resolve: useMock
    ? {
        alias: [
          { find: '@tauri-apps/api/core', replacement: '/src/lib/mock-tauri.ts' },
          { find: '@tauri-apps/api/event', replacement: '/src/lib/mock-tauri.ts' },
          { find: '@tauri-apps/api/window', replacement: '/src/lib/mock-tauri.ts' },
          { find: '@tauri-apps/plugin-dialog', replacement: '/src/lib/mock-tauri.ts' },
        ],
      }
    : undefined,
});
