import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    turbopackFileSystemCacheForDev: false,
  },
  "allowedDevOrigins": [
    "http://localhost",
    "192.168.0.42",
    "http://"
  ]
};

export default nextConfig;
