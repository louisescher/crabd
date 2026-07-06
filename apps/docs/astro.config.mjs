// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import starlight from '@astrojs/starlight';
import rapide from 'starlight-theme-rapide';
import llmsTxt from 'starlight-llms-txt';

import node from '@astrojs/node';

// https://astro.build/config
export default defineConfig({
  site: 'https://crabd.lou.gg',

  // Self-hosted fonts via Astro's font system (Fontsource provider — no Google Fonts).
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: 'Fraunces',
      cssVariable: '--font-fraunces',
      weights: [400, 600, 700],
      styles: ['normal'],
      subsets: ['latin'],
      fallbacks: ['Georgia', 'Times New Roman', 'serif'],
    },
  ],

  integrations: [
    starlight({
      title: "crab'd",
      description:
        "A forge-agnostic, multi-provider agent for @-mentions, PR reviews, and issue implementation on GitHub and Forgejo.",
      favicon: '/favicon.png',
      logo: { src: './src/assets/logo.png', alt: "crab'd" },
      components: {
        // Injects the self-hosted Fraunces <Font> into <head>.
        Head: './src/components/Head.astro',
      },
      plugins: [
        rapide(),
        llmsTxt({
          projectName: "crab'd",
          description:
            "A forge-agnostic, multi-provider agent for @-mentions, PR reviews, and issue implementation on GitHub and Forgejo.",
        }),
      ],
      customCss: ['./src/styles/crabd.css'],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/louisescher/crabd' }],
      sidebar: [
        { label: 'Start here', items: ['getting-started', 'skills'] },
        {
          label: 'Guides',
          items: ['configuration', 'custom-prompts', 'project-context', 'config-layering', 'data-egress'],
        },
        {
          label: 'Concepts',
          items: ['modes', 'output-schemas', 'custom-modes', 'mcp-servers'],
        },
        {
          label: 'Providers',
          items: [
            'providers',
            'providers/anthropic',
            'providers/openai',
            'providers/google',
            'providers/openai-compatible',
          ],
        },
        { label: 'Operating crab\'d', items: ['self-hosting', 'identity'] },
        {
          label: 'Reference',
          items: [
            'reference/config-yaml',
            'reference/rate-limiting',
            'reference/crabd-config-ts',
            'reference/environment-variables',
          ],
        },
      ],
    }),
  ],

  adapter: node({
    mode: 'standalone',
  }),
});