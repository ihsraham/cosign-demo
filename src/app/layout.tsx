import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'Yellow Co-Sign Checkout Demo',
  description: 'Two-party quorum checkout demo powered by Nitrolite compat SDK',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster
          position="top-right"
          richColors
          duration={4000}
          toastOptions={{
            className:
              '!border !border-white/60 !bg-white/85 !text-neutral-900 !shadow-[0_14px_26px_rgba(0,0,0,0.16)] backdrop-blur-md',
          }}
        />
      </body>
    </html>
  );
}
