import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@erc7824/nitrolite', '@erc7824/nitrolite-compat'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      '@react-native-async-storage/async-storage': false,
    };
    return config;
  },
};

export default nextConfig;
