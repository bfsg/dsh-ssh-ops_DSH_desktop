import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const release = join(root, "release");
const archiveRoot = `${pkg.name}-${pkg.version}`;
const stage = join(release, archiveRoot);

rmSync(release, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const entry of [".agent-presets", "assets", "lib", "src", "scripts", "test", "package.json", "package-lock.json", "cordis.patch.yml", "README.md", "LICENSE", "CHANGELOG.md"]) {
  const source = join(root, entry);
  if (existsSync(source)) cpSync(source, join(stage, basename(entry)), { recursive: true });
}

execSync(`npm pack --pack-destination ${JSON.stringify(release)}`, { cwd: root, stdio: "inherit" });
try {
  execSync(`zip -q -r -X ${JSON.stringify(join(release, `${archiveRoot}.zip`))} ${JSON.stringify(archiveRoot)}`, { cwd: release, stdio: "inherit" });
} catch (error) {
  console.warn(`package-release: zip skipped (${error.message}); the .tgz artifact is complete.`);
}
rmSync(stage, { recursive: true, force: true });

console.log(`release assets created in ${release}`);
