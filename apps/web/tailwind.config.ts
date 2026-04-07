import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          page:    '#0f0f0f',
          sidebar: '#1a1a1a',
          card:    '#1e1e1e',
          raised:  '#262626',
        },
        border: {
          subtle:  '#2d2d2d',
          visible: '#404040',
        },
        text: {
          primary:   '#ffffff',
          secondary: '#c8c8c8',
          muted:     '#9ca3af',
        },
        status: {
          healthy:  '#0474BA',
          warning:  '#FFA630',
          error:    '#FFA630',
          info:     '#0474BA',
        },
        accent: '#00A7E1',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
