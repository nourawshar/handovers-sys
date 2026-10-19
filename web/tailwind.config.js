/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        brand: {
          50: '#effcfa', 100: '#d5f7f1', 200: '#aeeee4', 300: '#7ddfd2', 400: '#4ac9bc',
          500: '#2aada3', 600: '#1f8b86', 700: '#1e6f6d', 800: '#1d5959', 900: '#1c4a4a',
        },
      },
      boxShadow: { card: '0 1px 2px rgba(15,23,42,.04), 0 1px 3px rgba(15,23,42,.06)' },
    },
  },
  plugins: [],
}
