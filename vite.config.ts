import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    watch: {
      // Large static media (audio, images) doesn't need HMR and can trip file
      // watchers on Windows (EBUSY) if something else has a file open.
      ignored: ['**/public/**/*.mp3', '**/public/**/*.jpg', '**/public/**/*.jpeg', '**/public/**/*.png'],
    },
  },
});
