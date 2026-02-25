import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@erc7824/nitrolite', '@erc7824/nitrolite-compat'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
};

export default nextConfig;
