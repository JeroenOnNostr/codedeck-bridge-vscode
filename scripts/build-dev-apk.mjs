#!/usr/bin/env node
/**
 * build-dev-apk.mjs — deterministic dev-APK build for the autonomous test loop.
 *
 * Reads .codedeck/device-config.json (written by the bridge when the phone sends set-device-config)
 * to decide which app to build, runs the app-specific build recipe, and prints a JSON result with
 * the APK path + package id + launch activity. The test-session agent calls this, then uses the
 * device MCP tools (install/launch/...) with the returned values.
 *
 * Usage:
 *   node scripts/build-dev-apk.mjs [--app kubo|veil|custom] [--workspace <dir>]
 * Env:
 *   CODEDECK_WORKSPACE  fallback workspace root (where .codedeck/ + project dirs live)
 *
 * Output (stdout, last line): JSON { ok, app, apkPath, package, activity?, error? }
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const WORKSPACE = resolve(
  arg('workspace', process.env.CODEDECK_WORKSPACE || join(homedir(), 'VScode workspace for building nostr apps')),
);

const JAVA_HOME = process.env.JAVA_HOME || join(homedir(), '.sdkman/candidates/java/current');
const ANDROID_HOME = process.env.ANDROID_HOME || join(homedir(), 'Android/Sdk');

function loadConfig() {
  const p = join(WORKSPACE, '.codedeck', 'device-config.json');
  if (existsSync(p)) {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* ignore */ }
  }
  return null;
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      JAVA_HOME,
      ANDROID_HOME,
      PATH: `${join(JAVA_HOME, 'bin')}:${process.env.PATH}`,
    },
    timeout: 20 * 60 * 1000,
  });
}

// App recipes. Each returns { apkPath, package, activity? } after building.
const RECIPES = {
  kubo() {
    const dir = join(WORKSPACE, 'kubo');
    // Web bundle → sync into the Android project → debug APK.
    run('npm', ['run', 'build'], dir);
    run('npx', ['cap', 'sync', 'android'], dir);
    run('node', ['scripts/patch-cap-config.mjs'], dir);
    run('./gradlew', ['assembleDebug'], join(dir, 'android'));
    return {
      apkPath: join(dir, 'android/app/build/outputs/apk/debug/app-debug.apk'),
      package: 'com.kubo.app',
      // NOTE: Kubo is a Ditto soft-fork — the launcher activity kept the upstream `pub.ditto.app`
      // namespace under the rebranded package. The Bridge's launch tool resolves the real launcher
      // activity on-device, so this is just a hint; an empty/omitted activity also works.
      activity: 'pub.ditto.app.MainActivity',
    };
  },
  veil() {
    const dir = join(WORKSPACE, 'veil/app');
    run('flutter', ['build', 'apk', '--debug', '--target-platform', 'android-arm64'], dir);
    return {
      apkPath: join(dir, 'build/app/outputs/flutter-apk/app-debug.apk'),
      package: 'io.veil.veil.dev',
      activity: 'io.veil.veil.MainActivity',
    };
  },
  custom(cfg) {
    const dir = cfg?.projectDir ? resolve(cfg.projectDir) : WORKSPACE;
    if (!cfg?.customBuildCmd) throw new Error('custom app requires customBuildCmd in device-config');
    // Run the user's build command via the shell (their own trusted config).
    run('bash', ['-lc', cfg.customBuildCmd], dir);
    if (!cfg.customApkPath) throw new Error('custom app requires customApkPath');
    return { apkPath: resolve(dir, cfg.customApkPath), package: cfg.customPackage, activity: undefined };
  },
};

function main() {
  const cfg = loadConfig();
  const app = arg('app', cfg?.appUnderTest || 'kubo');
  const recipe = RECIPES[app];
  if (!recipe) {
    console.log(JSON.stringify({ ok: false, app, error: `unknown app: ${app}` }));
    process.exit(1);
  }
  try {
    const out = recipe(cfg);
    if (!existsSync(out.apkPath)) {
      console.log(JSON.stringify({ ok: false, app, error: `APK not found after build: ${out.apkPath}` }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, app, ...out }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, app, error: String(e && e.message ? e.message : e) }));
    process.exit(1);
  }
}

main();
