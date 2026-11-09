/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // "standalone" is what the Docker image runs; on Vercel the platform builds the app its own way.
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
  async headers() {
    return [
      {
        source: "/activate",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;

