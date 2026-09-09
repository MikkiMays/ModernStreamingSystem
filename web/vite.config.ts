import { defineConfig } from 'vitest/config';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', ws: true },
      '/uploads': { target: 'http://127.0.0.1:1081' },
    },
  },
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
});
