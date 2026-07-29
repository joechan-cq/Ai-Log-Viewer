import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { VitePWA } from 'vite-plugin-pwa'

// BASE_PATH 用于部署到 GitHub Pages 子路径，例如 BASE_PATH=/Ai-Log-Formatter/ npm run build
const base = process.env.BASE_PATH ?? './'

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    // 大的 tool_result 全在运行时，产物本身不大；关掉 chunk 警告噪音
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        // 全部资源预缓存 —— 装完之后彻底断网可用
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'AI Log Formatter',
        short_name: 'AI Log',
        description: '离线查看并格式化 AI stream-json 日志',
        lang: 'zh-CN',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#0d0f14',
        theme_color: '#0d0f14',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Chrome 桌面端：双击 .log / .jsonl 直接用本应用打开
        file_handlers: [
          {
            action: '.',
            accept: {
              'application/x-ndjson': ['.jsonl', '.ndjson'],
              'text/plain': ['.log', '.txt'],
            },
          },
        ],
      } as never,
    }),
  ],
})
