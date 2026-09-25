import { execFileSync } from 'node:child_process';

// Built once for the whole run: the build script clears its output directory first,
// so two test files building it at the same time can fail.
export default function setup(): void {
  if (!process.env.RARS_JAR) return;
  execFileSync('scripts/build-java-bridge.sh', { stdio: 'inherit' });
}
