import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Project site served from https://<user>.github.io/Pacific-Rising/ - assets
  // must be requested under that sub-path, not the domain root.
  base: '/Pacific-Rising/',
  plugins: [react()],
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
})
