import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// GUI 构建（1.3.0）：产物 src/gui/dist（tauri.conf.json 的 frontendDist 指向）。
// base './' 保证 Tauri 资产协议下的相对资源路径；dev 端口对齐 devUrl:5173。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
