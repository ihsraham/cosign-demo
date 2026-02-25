import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/lib/**/*.{ts,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        yellow: {
          brand: '#FCD000',
          surface: '#FFF6CC',
          line: '#D4B21D'
        },
        ink: '#000000',
        paper: '#FFFFFF'
      },
      boxShadow: {
        card: '0 10px 24px rgba(0,0,0,0.14)'
      },
      backgroundImage: {
        'hero-grid': 'radial-gradient(circle at 10% 20%, rgba(252,208,0,0.32) 0%, rgba(252,208,0,0.04) 45%, rgba(0,0,0,0.06) 100%)'
      }
    }
  },
  plugins: []
};

export default config;
