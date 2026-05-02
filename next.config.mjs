/** @type {import('next').NextConfig} */
const nextConfig = {
  // Strict Mode double-mounts every component in dev, which breaks the maplibre
  // init flow (first map gets .remove()'d, second map's load events don't fire
  // properly). Disable in dev to keep the demo unblocked.
  reactStrictMode: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
