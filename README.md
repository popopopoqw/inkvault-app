# 墨匣 InkVault

Markdown 笔记应用，部署在 Cloudflare Workers 上。文字和图片在浏览器里加密后才上传，服务器（D1 数据库）只存密文；密码只在浏览器里派生密钥，不经过服务器，所以忘记密码数据就无法恢复。

![界面截图](docs/screenshot.png)

## 功能

- 编辑框内直接渲染 Markdown（所见即所得）：标题、加粗、代码块、引用、表格、任务列表即写即显。光标行也保持渲染，只有光标贴着 `#`、`**` 这类标记时才显示源码。顶栏可切换纯预览阅读
- 插入图片：粘贴截图、拖拽文件或工具栏按钮。图片先压缩（最长边 1600px、JPEG 82%，SVG/GIF 原样保留，原图限 8MB）再加密上传，编辑框和预览里直接显示
- 文件树：文件夹/文档层级，新建、重命名、删除、拖拽排序
- 大纲：随内容实时更新，点击跳转，随滚动高亮
- 自动保存：停顿 1.5 秒后加密上传，多设备编辑有版本冲突检测
- 登录防护：密码错误 5 次锁定 15 分钟，会话 7 天有效

服务端能看到的信息只有：会话哈希、文档树的层级结构（不含名称和内容）、密文、时间戳。

## 技术栈

React 18 + TypeScript + Vite，CodeMirror 6，markdown-it + highlight.js，zustand，Hono，Cloudflare Workers + D1。本地开发用 `@cloudflare/vite-plugin`，与线上同一运行时。

## 本地开发

```bash
npm install
npx wrangler d1 migrations apply markdown-editor --local
npm run dev   # http://localhost:5173
```

## 部署

```bash
npx wrangler login
npx wrangler d1 create markdown-editor   # 把返回的 database_id 填入 wrangler.jsonc
npx wrangler d1 migrations apply markdown-editor --remote
npm run deploy
```

打开 Workers 分配的域名，首次访问设置密码即可使用。

## 桌面客户端

`src-tauri/` 是桌面端（macOS、Windows），作为你部署的服务地址的壳：首启动填一次服务地址，之后打开即用，加密流程与网页版相同。

打包推送 tag 触发（如 `v0.1.0`），GitHub Actions 用 tauri-action 构建三个产物（Apple Silicon dmg、Intel dmg、Windows nsis 安装包，约 5MB），进入 Releases 草稿。应用未做代码签名：macOS 首次打开右键选"打开"，Windows 遇 SmartScreen 选"仍要运行"。

## 目录结构

```
src/
├── worker/       # Hono API：认证、会话、文档与图片的密文 CRUD
├── lib/          # 加密（WebCrypto）、即时渲染插件、图片处理、markdown 渲染、请求封装
├── store/        # zustand：认证流程、文档树、自动保存
└── components/   # 登录、文件树、编辑器、预览与大纲、图标
migrations/       # D1 表结构
```
