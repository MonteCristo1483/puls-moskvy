import type { NextConfig } from "next";

// Статический экспорт для GitHub Pages: сайт живёт в подпапке репозитория
// (/puls-moskvy), поэтому все ресурсы в коде — относительные пути
// (map.tsx: fetch GeoJSON и setWorkerUrl).
// assetPrefix равен basePath: без него Turbopack оставляет часть ссылок на
// чанки абсолютными (/_next/static/...) — они 404 в подпапке Pages.
const nextConfig: NextConfig = {
  output: "export",
  distDir: "dist",
  basePath: "/puls-moskvy",
  assetPrefix: "/puls-moskvy",
  trailingSlash: true,
};

export default nextConfig;
