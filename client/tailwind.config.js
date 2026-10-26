/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#07090e',
          900: '#0b0e14',
          850: '#0e1219',
          800: '#121722',
          750: '#161c28',
          700: '#1b2230',
        },
        line: {
          DEFAULT: '#1f2735',
          strong: '#2b3547',
        },
        fg: {
          DEFAULT: '#e8ebf2',
          muted: '#98a2b3',
          dim: '#6b7688',
        },
        accent: {
          DEFAULT: '#7c9cff',
          strong: '#5b7cfa',
          soft: 'rgba(124, 156, 255, 0.12)',
        },
        ok: '#3ddc97',
        warn: '#f5b849',
        danger: '#fb7185',
        info: '#5eb0f8',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 18px 48px -24px rgba(0,0,0,0.9)',
        glow: '0 0 0 1px rgba(124,156,255,0.35), 0 8px 30px -8px rgba(91,124,250,0.45)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '0.35', transform: 'scale(0.9)' },
          '50%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 180ms ease-out both',
        shimmer: 'shimmer 1.6s linear infinite',
        'pulse-dot': 'pulseDot 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
