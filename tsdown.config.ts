import { defineConfig } from 'tsdown'

/**
 * 自包含构建：直接把 src/ 转译为 lib/（单文件 ESM，@deepseek-ai/* 保持 external）。
 * 不依赖任何 monorepo 上下文，可作为 npm `prepare` 脚本在 git 安装时运行。
 */
export default defineConfig({
  entry: ['./src/index.ts'],
  outDir: './lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: {
    neverBundle: ['@deepseek-ai/*'],
  },
})
