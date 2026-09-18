/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The backend URL is read at request time so the same image can be
  // deployed against different environments.
  env: {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000",
  },
};

export default nextConfig;
