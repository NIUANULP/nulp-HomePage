const nextConfig = {
  images: {
    domains: ["localhost", "devnulp.niua.org", "nulp.niua.org"],
    unoptimized: true,
  },
  // Conditionally enable static export only for production builds
  ...(process.env.NODE_ENV === "production" && { output: "export" }),
  async rewrites() {
    return [
      // Serve /sunbird and /sunbird/ as /sunbird/index.html
      { source: "/sunbird", destination: "/sunbird/index.html" },
      { source: "/sunbird/", destination: "/sunbird/index.html" },
      // Serve single-segment clean paths as their corresponding .html
      { source: "/sunbird/:slug", destination: "/sunbird/:slug.html" },
    ];
  },
  async redirects() {
    return [
      // Redirect .html URLs to clean versions
      {
        source: "/sunbird/index.html",
        destination: "/sunbird",
        permanent: true,
      },
      {
        source: "/sunbird/:slug.html",
        destination: "/sunbird/:slug",
        permanent: true,
      },
    ];
  },
};
module.exports = nextConfig;
