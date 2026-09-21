import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://screencapture.dev',
  integrations: [
    starlight({
      title: 'ScreenCapture',
      description:
        'FiveM screenshot, WebM video, and live game-view streaming documentation.',
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Start Here',
          items: [
            { label: 'Overview', slug: 'index' },
            { label: 'Installation', slug: 'installation' },
            { label: 'Configuration', slug: 'configuration' },
          ],
        },
        {
          label: 'Capture APIs',
          items: [
            { label: 'Screenshots', slug: 'screenshots' },
            { label: 'Video', slug: 'video' },
            { label: 'Live streaming', slug: 'live-streaming' },
          ],
        },
        {
          label: 'Packages',
          items: [
            { label: 'Game view canvas', slug: 'packages/gameview' },
            { label: 'Live viewer SDK', slug: 'packages/live' },
          ],
        },
        {
          label: 'Examples',
          items: [{ label: 'Realtime workflows', slug: 'examples/realtime' }],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Compatibility exports', slug: 'compatibility' },
            { label: 'Operations', slug: 'operations' },
          ],
        },
      ],
    }),
  ],
});