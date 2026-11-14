import esbuild from "esbuild";
import { builtinModules } from "node:module";

// Obsidian provides these at runtime; bundling a second copy of CodeMirror breaks the editor.
const external = ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "@codemirror/language", "@lezer/common", ...builtinModules];
const options = { entryPoints: ["src/main.ts"], outfile: "main.js", bundle: true, format: "cjs", target: "es2018", external, logLevel: "info", minify: true };

if (process.argv.includes("--watch")) await (await esbuild.context({ ...options, minify: false, sourcemap: "inline" })).watch();
else await esbuild.build(options);
