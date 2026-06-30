import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    base: '/omnichat/',
    optimizeDeps: {
    exclude: ['@mlc-ai/web-llm'],
    },
    worker: {
        format: 'es', // needed since web-llm spins up a Web Worker internally
    },
    })
