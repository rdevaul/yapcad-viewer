import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "yapCAD Viewer — Semantic Package Inspection",
  description: "Inspect validated yapCAD engineering packages, assemblies, and analytic BREP-derived scenes.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
