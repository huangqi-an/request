import { defineConfig } from 'tsup'

// 三个入口：主入口（契约 + fetchAdapter + 拦截器 + 装饰器，零依赖全量）
// 与两个平台耦合适配器（axios 依赖 / uni 全局）。
// splitting 关闭：产物自包含，无共享 chunk；入口间重复的公共代码仅数 KB。
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapters/axios': 'src/adapters/axios.ts',
    'adapters/uniapp': 'src/adapters/uniapp.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: false,
  clean: true,
  sourcemap: true,
  target: 'es2020',
})
