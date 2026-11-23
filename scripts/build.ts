// Builds the dashboard into static files in dist/dashboard, for hosts that serve it as files rather than through
// Bun.serve's HTML import. The page's assets are served under /dashboard/, where the dashboard lives.
import tailwind from "bun-plugin-tailwind";

const outdir = "dist/dashboard";
const result = await Bun.build({
  entrypoints: ["apps/web/index.html"],
  outdir,
  publicPath: "/dashboard/",
  plugins: [tailwind],
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`Built ${outdir}`);
