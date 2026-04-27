import type { ReactNode } from "react";

export const metadata = {
  title: "rmind-agents",
  description: "Self-hosted coding agents — proxy",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
