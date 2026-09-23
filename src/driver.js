"use strict";

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { app } = require('electron');

const execFileAsync = promisify(execFile);

const INSTALL_INFS = ['qcser.inf', 'qcmdm.inf', 'qcfilter.inf'];
const WWAN_INF = 'qcwwan.inf';
const TEMP_DIR_NAME = 'dji-4g-toolkit-drivers';

function isPackaged() {
  try {
    return !!(app && app.isPackaged);
  } catch {
    return false;
  }
}

function projectRoot() {
  if (isPackaged()) {
    // extraResources land in process.resourcesPath
    return process.resourcesPath;
  }
  // Development: repo root (src/ -> ../)
  return path.resolve(__dirname, '..');
}

function driversWindows10Dir() {
  return path.join(projectRoot(), 'drivers', 'windows10');
}

function installScriptPath() {
  return path.join(projectRoot(), 'scripts', 'Install-Drivers.ps1');
}

async function prepareDriverTree({ requireWwan = false } = {}) {
  const src = driversWindows10Dir();
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    throw new Error(`Bundled drivers not found: ${src}`);
  }
  for (const inf of INSTALL_INFS) {
    const p = path.join(src, inf);
    if (!fs.existsSync(p)) throw new Error(`Missing required INF: ${p}`);
  }
  if (requireWwan) {
    const p = path.join(src, WWAN_INF);
    if (!fs.existsSync(p)) throw new Error(`Missing WWAN INF: ${p}`);
  }

  if (!isPackaged()) {
    return src;
  }

  // Copy to TEMP so elevated PowerShell has a stable writable path.
  const dest = path.join(os.tmpdir(), TEMP_DIR_NAME, 'windows10');
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await copyDir(src, dest);
  return dest;
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await fsp.copyFile(from, to);
  }
}

async function copyInstallScript(driverDir) {
  const srcScript = installScriptPath();
  if (!fs.existsSync(srcScript)) {
    throw new Error(`Install-Drivers.ps1 not found: ${srcScript}`);
  }
  if (!isPackaged()) return srcScript;

  const dest = path.join(path.dirname(driverDir), 'Install-Drivers.ps1');
  await fsp.copyFile(srcScript, dest);
  return dest;
}

/**
 * Elevate Install-Drivers.ps1 with -DriverDir pointing at bundled windows10.
 * opts: { includeWwan?: boolean, wwanOnly?: boolean }
 * Returns { ok, message, logPath, exitCode }.
 */
async function launchElevatedInstall(opts = {}) {
  const includeWwan = !!(opts && opts.includeWwan);
  const wwanOnly = !!(opts && opts.wwanOnly);

  if (process.platform !== 'win32') {
    return { ok: false, message: 'Driver install is Windows-only.', exitCode: -1 };
  }

  let driverDir;
  let script;
  try {
    driverDir = await prepareDriverTree({ requireWwan: includeWwan || wwanOnly });
    script = await copyInstallScript(driverDir);
  } catch (err) {
    return { ok: false, message: String(err.message || err), exitCode: -1 };
  }

  const logPath = path.join(os.tmpdir(), 'dji-4g-toolkit-driver-install.log');
  const modeLabel = wwanOnly
    ? 'WWAN only (qcwwan.inf)'
    : includeWwan
      ? 'serial + WWAN'
      : 'serial only (qcser/qcmdm/qcfilter)';
  const preamble = [
    `Mode: ${modeLabel}`,
    `Drivers: ${driverDir}`,
    `Script: ${script}`,
    `Log file: ${logPath}`,
  ].join('\n');

  // Escape single quotes for PowerShell single-quoted strings.
  const esc = (s) => String(s).replace(/'/g, "''");
  const argList = [
    "'-NoProfile'",
    "'-ExecutionPolicy'",
    "'Bypass'",
    "'-File'",
    `'${esc(script)}'`,
    "'-DriverDir'",
    `'${esc(driverDir)}'`,
  ];
  if (wwanOnly) argList.push("'-WwanOnly'");
  else if (includeWwan) argList.push("'-IncludeWwan'");

  const ps = [
    `$p = Start-Process -FilePath 'powershell.exe'`,
    `-ArgumentList @(${argList.join(',')})`,
    `-Verb RunAs -Wait -PassThru;`,
    `exit $p.ExitCode`,
  ].join(' ');

  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 600000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
    ).catch((err) => {
      // execFile rejects on non-zero exit; still surface stdout/stderr/code
      const code = typeof err.code === 'number' ? err.code : -1;
      const detail = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`.trim();
      const e = new Error(detail || String(err));
      e.exitCode = code;
      e.stdout = err.stdout;
      e.stderr = err.stderr;
      throw e;
    });

    const detail = `${stdout || ''}${stderr || ''}`.trim();
    return {
      ok: true,
      message: `${preamble}\nDriver install finished OK (exit 0). See ${logPath}\n${detail}`.trim(),
      logPath,
      exitCode: 0,
    };
  } catch (err) {
    const code = typeof err.exitCode === 'number' ? err.exitCode : -1;
    const detail = String(err.message || err);
    if (code === 1223 || code === 5) {
      return {
        ok: false,
        message: `${preamble}\nUAC cancelled or access denied (exit ${code}).`,
        logPath,
        exitCode: code,
      };
    }
    return {
      ok: false,
      message: `${preamble}\nDriver install exited ${code}. See ${logPath}\n${detail}`.trim(),
      logPath,
      exitCode: code,
    };
  }
}

function resourcePaths() {
  return {
    root: projectRoot(),
    drivers: driversWindows10Dir(),
    script: installScriptPath(),
    packaged: isPackaged(),
  };
}

module.exports = {
  INSTALL_INFS,
  WWAN_INF,
  prepareDriverTree,
  launchElevatedInstall,
  resourcePaths,
  projectRoot,
};
