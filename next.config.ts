import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * `imapflow` and `mailparser` are Node libraries with dynamic requires and
   * optional native-adjacent dependencies. Bundling them produces opaque runtime
   * failures, so they are loaded from node_modules at runtime instead.
   */
  serverExternalPackages: ["imapflow", "mailparser"],
};

export default nextConfig;
