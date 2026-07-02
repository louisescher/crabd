// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rapide from 'starlight-theme-rapide';
import llmsTxt from 'starlight-llms-txt';

import node from '@astrojs/node';

// https://astro.build/config
export default defineConfig({
  site: 'https://crabd.lou.gg',

  integrations: [
    starlight({
      title: "crab'd",
      description:
        "A forge-agnostic, multi-provider agent for @-mentions, PR reviews, and issue implementation on GitHub and Forgejo.",
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
          items: ['configuration', 'custom-prompts', 'config-layering', 'data-egress'],
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
          items: ['reference/config-yaml', 'reference/crabd-config-ts', 'reference/environment-variables'],
        },
      ],
    }),
  ],

  adapter: node({
    mode: 'standalone',
  }),
});