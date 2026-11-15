/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        accent: { DEFAULT: '#006B59', hover: '#005A4B', soft: '#E3EFEB' },
        dark: { DEFAULT: '#10251E', 2: '#1C3A31', term: '#0C1714' },
        mint: { DEFAULT: '#8EE0C5' },
        canvas: '#F4F7F6',
        ink: { DEFAULT: '#10251E', 2: '#4B5C57', 3: '#7A8A85' },
        line: '#DCE3E0',
        amber: { soft: '#FFF3DC', ink: '#8A5A00' },
        rose: { soft: '#FBE3E3', ink: '#A1262B' },
      },
      boxShadow: { card: '0 1px 2px rgba(16,37,30,0.04)' },
    },
  },
  plugins: [],
};
