import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative asset URLs, so dist/ works from any static host path
  build: {
    chunkSizeWarningLimit: 1100, // maplibre-gl alone is ~1 MB minified and can't be split further
    rolldownOptions: {
      output: {
        // Vendor chunks stay cached across app-only redeploys.
        codeSplitting: {
          groups: [
            { name: 'maplibre', test: /node_modules[\\/]maplibre-gl[\\/]/ },
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
          ],
        },
      },
    },
  },
});
