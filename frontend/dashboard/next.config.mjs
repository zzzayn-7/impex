/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // "standalone" is what the Docker image runs; on Vercel the platform builds the app its own way.
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
};

export default nextConfig;
