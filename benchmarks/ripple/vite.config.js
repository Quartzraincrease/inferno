import { defineConfig } from "vite";
import { ripple } from "@ripple-ts/vite-plugin";

export default defineConfig({
  build: {
    target: "es2022",
    minify: "terser",
  },
  plugins: [ripple()],
});
