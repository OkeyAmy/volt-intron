import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import Nav from "./Nav";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sautice — voice to invoice",
  description:
    "Turn a spoken sale in naturally mixed Nigerian speech into a reviewed, confirmed invoice.",
  icons: { icon: "/favicon.svg" },
};

export const viewport = {
  themeColor: "#16233F",
  width: "device-width",
  initialScale: 1,
};

function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-hidden="true" width="28" height="28">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 13 Q5.5 3.5 8.5 13 Q11.5 22.5 14.5 13 L29.5 13" stroke="currentColor" strokeWidth="2.6" />
        <path d="M17 20.5 L29.5 20.5" stroke="var(--tally)" strokeWidth="2.6" />
      </g>
    </svg>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={archivo.variable}>
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        <header className="app-header">
          <div className="app-bar">
            <Link href="/" className="app-brand" aria-label="Sautice home">
              <BrandMark />
              <span>Sautice</span>
            </Link>
            <Nav />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
