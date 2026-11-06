import { defineConfig } from 'tsup'

// 每个子路径单独打包：保持"按需导入"的 tree-shaking 语义
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/core.ts',
    'src/errors.ts',
    'src/adapters/fetch.ts',
    'src/adapters/axios.ts',
    'src/adapters/uniapp.ts',
    'src/interceptors/index.ts',
    'src/interceptors/auth.ts',
    'src/interceptors/request-id.ts',
    'src/interceptors/unwrap.ts',
    'src/interceptors/logger.ts',
    'src/enhancers/retry.ts',
    'src/enhancers/dedupe.ts',
  ],
  format: ['esm'],
  dts: true,
  splitting: true,
  clean: true,
  sourcemap: true,
  target: 'es2020',
})
