import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    // How the browser sends speech. "stream" uses the live WebSocket gateway in
    // server.mts (container hosts); "upload" records first and POSTs to
    // /api/voice/transcribe, which is what a serverless host like Vercel can run.
    // Vercel sets VERCEL=1 during its build, so it gets "upload" automatically;
    // setting NEXT_PUBLIC_VOICE_TRANSPORT explicitly always wins.
    NEXT_PUBLIC_VOICE_TRANSPORT:
      process.env.NEXT_PUBLIC_VOICE_TRANSPORT ?? (process.env.VERCEL === "1" ? "upload" : "stream"),
  },
  // Native-leaning drivers run as plain Node dependencies instead of being bundled.
  serverExternalPackages: ["ws", "postgres"],
};

export default nextConfig;
