import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Perform — offer experiments",
  description: "Controlled Fanvue offer experiments without crossed cohorts or false certainty.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
