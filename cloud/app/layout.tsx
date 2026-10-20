import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "沙季 · 我们的日常",
  description: "私人的文字聊天伙伴，聊天与记忆随账号保存。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
