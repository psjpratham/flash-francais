import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves project sites under /<repo-name>/, not the domain root,
  // so built asset URLs need this prefix or they 404 once deployed.
  base: '/flash_francais/',
  server: {
    watch: {
      // Large static media (audio, images) doesn't need HMR and can trip file
      // watchers on Windows (EBUSY) if something else has a file open.
      ignored: ['**/public/**/*.mp3', '**/public/**/*.jpg', '**/public/**/*.jpeg', '**/public/**/*.png'],
    },
  },
});
